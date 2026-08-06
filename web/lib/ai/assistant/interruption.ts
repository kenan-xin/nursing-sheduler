// THE interruption controller (T05, tech-plan "Strict interruption, settlement, and
// detachment").
//
// ONE controller for Stop, Disable, Remove key, Replace configuration, Clear history,
// Clear all, scenario switch, lease loss, and takeover. The tech plan is explicit
// that partial cancellation logic must not be duplicated across Settings, the chat
// panel and diagnostics, so every one of those actions calls this and nothing else.
// It REPLACES T04's minimum Stop path rather than sitting beside it.
//
// THE ORDER IS THE CONTRACT, and each step exists because the previous one cannot
// cover it:
//
//   1. CLEAR FENCE FIRST (clear triggers only). The generation is incremented before
//      anything asynchronous starts, so from this instant no in-flight write can
//      land -- including one that arrives after the 15-second detachment, after a
//      reload, or after the runtime restarts. An in-memory flag could not do this: a
//      reload clears the flag, and the late write would recreate deleted data.
//
//   2. LOCAL CLOSURE, SYNCHRONOUSLY. The turn epoch advances and the authorised epoch
//      is dropped, which closes sends and tool handlers immediately. Nothing is
//      awaited here on purpose: the gate must be shut before the first `await` yields
//      control back to a streaming callback.
//
//   3. ASYNCHRONOUS CANCELLATION, IN PARALLEL. Abort the browser's stream, ask the
//      runtime to stop the server-side run, and ask T10's owner to cancel every owned
//      non-terminal job. Bytes already sent to the provider cannot be recalled, and
//      this code never pretends otherwise.
//
//   4. BOUNDED SETTLEMENT. Wait at most {@link SETTLEMENT_WINDOW_MS}. Everything still
//      unacknowledged is marked Detached -- never a synthesised provider completion.
//
//   5. DELETE AFTER SETTLEMENT (clear triggers only). The second transaction rereads
//      the exact generations step 1 produced, so a clear that raced this one wins and
//      this pass deletes nothing.
//
// EVERY DEPENDENCY IS INJECTED and none of them is React, a store, or an agent
// instance. That is what makes the refusal/settlement matrix testable against slow
// runtime, slow tool and slow job fixtures without mounting a panel.

import type { ClearDeletion, ClearFence, ClearScope } from "./clear-repo";
import type {
  DiagnosticCancellationAck,
  DiagnosticCancellationRequest,
  DiagnosticCancellationSummary,
} from "./diagnostic-cancellation";
import { summarizeCancellations } from "./diagnostic-cancellation";
import {
  isDetachedSettlement,
  isClearTrigger,
  recordLifecycleEvent,
  type AssistantSettlement,
  type InterruptionPhase,
  type InterruptionTrigger,
  type RuntimeStopOutcome,
} from "./lifecycle";
import type { TurnScope, WriteOutcome } from "./history-repo";
import type { AssistantTurnV1 } from "./records";
import { isConfirmedStop, type ActiveRunHandle } from "./runtime-stop";

/**
 * The bounded settlement window. Fifteen seconds is the closed product contract, not
 * a tuning knob: the UI promises "we will stop claiming to be cancelling within 15
 * seconds" and the backend may legitimately finish a job under ordinary retention
 * afterwards.
 */
export const SETTLEMENT_WINDOW_MS = 15_000;

export interface InterruptionRequest {
  trigger: InterruptionTrigger;
  /** The thread to scope to, or `null` for "every thread" (Clear all, Disable). */
  threadId: string | null;
  scenarioId: string | null;
}

export interface InterruptionDeps {
  now(): Date;
  /**
   * Shut the local gate and return the epoch that is now closed. MUST be
   * synchronous: an `await` before the gate closes is a window in which a streaming
   * callback or a tool handler is still authorised.
   */
  closeGate(trigger: InterruptionTrigger): number;
  publishPhase(phase: InterruptionPhase, trigger: InterruptionTrigger): void;
  readUnsettledTurns(scope: TurnScope): Promise<AssistantTurnV1[]>;
  setTurnState(
    turnId: string,
    input: {
      state: "stopping" | "settling" | "terminal" | "detached";
      settlement?: AssistantSettlement | null;
      trigger?: InterruptionTrigger | null;
    },
  ): Promise<WriteOutcome>;
  /** Abort the browser's stream. Returns the run that was aborted, or `null`. */
  abortLocalRun(): ActiveRunHandle | null;
  requestRuntimeStop(input: { threadId: string; signal: AbortSignal }): Promise<RuntimeStopOutcome>;
  cancelDiagnostics(request: DiagnosticCancellationRequest): Promise<DiagnosticCancellationAck[]>;
  beginClear(scope: ClearScope, scenarioId: string | null): Promise<ClearFence>;
  finishClear(fence: ClearFence): Promise<ClearDeletion>;
  /**
   * Resolves when the settlement window elapses, or never if `signal` aborts first.
   * Injected so a suite can close the window deterministically instead of waiting
   * fifteen real seconds.
   */
  settlementWindow(ms: number, signal: AbortSignal): Promise<void>;
}

export interface InterruptionResult {
  trigger: InterruptionTrigger;
  /** The epoch that was closed. Nothing authorised under it may publish again. */
  closedTurnEpoch: number;
  runtime: RuntimeStopOutcome;
  diagnostics: DiagnosticCancellationSummary;
  settlement: AssistantSettlement;
  phase: InterruptionPhase;
  /** Turns whose state this interruption actually wrote. */
  settledTurnIds: string[];
  /** Turns whose state write was fenced -- their data is being deleted anyway. */
  fencedTurnIds: string[];
  /** Present for the clear triggers only. */
  clear: { fence: ClearFence; deletion: ClearDeletion } | null;
}

/**
 * Interrupt every piece of live assistant authority for one trigger.
 *
 * Never throws for an expected condition. A fenced turn write, an unreachable
 * runtime, a missing stop target, an instance mismatch and an unconfirmed job
 * cancellation are all NORMAL results reported in the return value -- because each of
 * them has a correct user-facing state, and an exception would instead surface as a
 * failure the user is invited to retry.
 */
export async function interrupt(
  request: InterruptionRequest,
  deps: InterruptionDeps,
): Promise<InterruptionResult> {
  const { trigger } = request;

  // ---- 1. Clear fence, before anything asynchronous ----------------------
  const fence = isClearTrigger(trigger)
    ? await deps.beginClear(trigger === "clear_all" ? "all" : "history", request.scenarioId)
    : null;

  // ---- 2. Local closure, synchronously -----------------------------------
  const closedTurnEpoch = deps.closeGate(trigger);
  deps.publishPhase("closing", trigger);
  recordLifecycleEvent({ trigger, phase: "closing", at: deps.now() });

  const scope = turnScopeFor(request);
  const unsettled = await deps.readUnsettledTurns(scope);
  for (const turn of unsettled) {
    await deps.setTurnState(turn.turnId, { state: "stopping", trigger });
  }

  // ---- 3. Asynchronous cancellation, in parallel -------------------------
  deps.publishPhase("cancelling", trigger);
  const aborted = deps.abortLocalRun();

  const window = new AbortController();
  const progress: { runtime: RuntimeStopOutcome; acks: DiagnosticCancellationAck[] } = {
    runtime: "not_attempted",
    acks: [],
  };

  const cancellation = Promise.all([
    (async () => {
      // One tab mounts one agent for one thread, so at most one server-side run can
      // belong to it: the aborted handle names it, and an unsettled turn names it when
      // the handle is already gone (a panel that unmounted mid-turn).
      const threadId = aborted?.threadId ?? unsettled[0]?.threadId ?? request.threadId;
      // No thread and no aborted run means no server-side run was ever started, so
      // there is nothing to stop -- which is `not_attempted`, not a failed stop.
      if (!threadId || (!aborted && unsettled.length === 0)) return;
      progress.runtime = await deps.requestRuntimeStop({ threadId, signal: window.signal });
    })(),
    (async () => {
      try {
        progress.acks = await deps.cancelDiagnostics({
          trigger,
          threadId: scope.kind === "thread" ? scope.threadId : null,
          scenarioId: request.scenarioId,
          closedTurnEpoch,
          signal: window.signal,
        });
      } catch {
        // A canceller that throws has told us nothing, which is exactly the
        // "cancellation could not be confirmed" case -- so it detaches rather than
        // failing the interruption. The gate is already closed either way.
        progress.acks = [{ jobId: "unknown", state: "unconfirmed" }];
        recordLifecycleEvent({
          trigger,
          phase: "cancelling",
          at: deps.now(),
          errorClass: "diagnostic_cancel_failed",
        });
      }
    })(),
  ]);

  deps.publishPhase("settling", trigger);
  for (const turn of unsettled) {
    await deps.setTurnState(turn.turnId, { state: "settling", trigger });
  }

  // ---- 4. Bounded settlement --------------------------------------------
  const timedOut = await Promise.race([
    cancellation.then(() => false),
    deps.settlementWindow(SETTLEMENT_WINDOW_MS, window.signal).then(() => true),
  ]);
  // Aborting the window signal both cancels the timer and tells a still-pending
  // diagnostic canceller to stop waiting. Its work is detached from here on: a job
  // that finishes later may appear in ordinary job history and nothing more.
  window.abort();

  const diagnostics = summarizeCancellations(progress.acks);
  const settlement = classifySettlement({
    timedOut,
    runtime: progress.runtime,
    diagnostics,
  });
  const detached = isDetachedSettlement(settlement);

  const settledTurnIds: string[] = [];
  const fencedTurnIds: string[] = [];
  for (const turn of unsettled) {
    const outcome = await deps.setTurnState(turn.turnId, {
      state: detached ? "detached" : "terminal",
      settlement,
      trigger,
    });
    if (outcome === "fenced") fencedTurnIds.push(turn.turnId);
    else if (outcome === "accepted") settledTurnIds.push(turn.turnId);
  }

  // ---- 5. Delete after settlement (clear triggers only) ------------------
  let clear: InterruptionResult["clear"] = null;
  if (fence) {
    clear = { fence, deletion: await deps.finishClear(fence) };
  }

  const phase: InterruptionPhase = fence ? "cleared" : detached ? "detached" : "settled";
  deps.publishPhase(phase, trigger);
  recordLifecycleEvent({
    trigger,
    phase,
    at: deps.now(),
    settlement,
    runtime: progress.runtime,
    turns: settledTurnIds.length,
    diagnosticsRequested: diagnostics.requested,
    diagnosticsConfirmed: diagnostics.confirmed,
  });

  return {
    trigger,
    closedTurnEpoch,
    runtime: progress.runtime,
    diagnostics,
    settlement,
    phase,
    settledTurnIds,
    fencedTurnIds,
    clear,
  };
}

/**
 * Which turns this trigger is responsible for settling.
 *
 * Clear all and Disable close the whole app's assistant work. Everything else is
 * scoped as narrowly as the caller could name it, so interrupting one scenario never
 * settles another's live turn.
 */
function turnScopeFor(request: InterruptionRequest): TurnScope {
  if (request.trigger === "clear_all" || request.trigger === "disable") return { kind: "all" };
  if (request.threadId) return { kind: "thread", threadId: request.threadId };
  if (request.scenarioId) return { kind: "scenario", scenarioId: request.scenarioId };
  return { kind: "all" };
}

/**
 * Map the settlement facts onto one bounded class.
 *
 * The precedence is deliberate: any unconfirmed fact wins over any confirmed one,
 * because "we could not confirm part of this" is the truthful summary of a mixed
 * outcome. Only when everything came back does the app say Stopped or Cancelled.
 */
function classifySettlement(input: {
  timedOut: boolean;
  runtime: RuntimeStopOutcome;
  diagnostics: DiagnosticCancellationSummary;
}): AssistantSettlement {
  if (input.timedOut) return "detached_timeout";
  if (!isConfirmedStop(input.runtime)) return "detached_runtime";
  if (input.diagnostics.unresolved > 0) return "detached_timeout";
  return input.diagnostics.confirmed > 0 ? "cancelled" : "stopped";
}

/**
 * The default settlement timer. A real `setTimeout`, cleared on abort so an
 * interruption that settles quickly does not keep a 15-second handle alive.
 */
export function realSettlementWindow(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return;
    const handle = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
      },
      { once: true },
    );
  });
}
