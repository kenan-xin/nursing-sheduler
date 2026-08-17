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

/**
 * How many times a clear may recapture the world before giving up and saying so.
 *
 * Three, because each attempt runs after the gate is closed and the settlement window
 * has passed: one retry covers a write that landed in the same tick, and a clear that
 * loses three times is contending with something this bound cannot fix.
 */
export const CLEAR_RECAPTURE_LIMIT = 3;

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

/**
 * The facts of ONE interruption, accumulated as each stage establishes them.
 *
 * WHY AN ACCUMULATOR AND NOT JUST A RETURN VALUE. `interrupt` throws only for genuine
 * storage failures, and those land at a specific stage -- most often the deletion
 * transaction, which runs AFTER the gate closed, after cancellation, and after the
 * bounded settlement window has already produced a real settlement class. Reporting
 * that failure as `{ closedTurnEpoch: 0, runtime: "not_attempted", settlement:
 * "run_failed" }` would not be classifying an unknown; it would be discarding facts
 * this controller had already established and replacing them with fiction.
 *
 * The caller owns the object and reads it after a throw. Every field is `null` until
 * its stage completes, so "not known" and "known to be nothing" stay distinguishable.
 */
export interface InterruptionProgress {
  /** The clear fence, once `beginClear` has committed. */
  fence: ClearFence | null;
  /** The epoch closed synchronously at step 2. */
  closedTurnEpoch: number | null;
  runtime: RuntimeStopOutcome | null;
  diagnostics: DiagnosticCancellationSummary | null;
  /** The real bounded settlement class from step 4. */
  settlement: AssistantSettlement | null;
  settledTurnIds: string[];
  fencedTurnIds: string[];
  /** The deletion result from step 5, once `finishClear` has returned. */
  deletion: ClearDeletion | null;
}

export function emptyInterruptionProgress(): InterruptionProgress {
  return {
    fence: null,
    closedTurnEpoch: null,
    runtime: null,
    diagnostics: null,
    settlement: null,
    settledTurnIds: [],
    fencedTurnIds: [],
    deletion: null,
  };
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
  /**
   * Filled in stage by stage, so a caller can read what was already established even
   * when a later stage throws. See {@link InterruptionProgress}.
   */
  progress: InterruptionProgress = emptyInterruptionProgress(),
): Promise<InterruptionResult> {
  const { trigger } = request;

  // ---- 1. Clear fence, before anything asynchronous ----------------------
  const fence = isClearTrigger(trigger)
    ? await deps.beginClear(trigger === "clear_all" ? "all" : "history", request.scenarioId)
    : null;
  progress.fence = fence;

  // ---- 2. Local closure, synchronously -----------------------------------
  const closedTurnEpoch = deps.closeGate(trigger);
  progress.closedTurnEpoch = closedTurnEpoch;
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
  const cancelled: { runtime: RuntimeStopOutcome; acks: DiagnosticCancellationAck[] } = {
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
      cancelled.runtime = await deps.requestRuntimeStop({ threadId, signal: window.signal });
    })(),
    (async () => {
      try {
        cancelled.acks = await deps.cancelDiagnostics({
          trigger,
          threadId: scope.kind === "thread" ? scope.threadId : null,
          // CANCELLATION SCOPE IS THE TURN SCOPE, derived from the trigger -- not the
          // scenario the user happened to have selected. Clear all and Disable close
          // every turn in the tab, so they must ask every owned diagnostic job to stop;
          // passing the selected scenario made the canceller filter out every OTHER
          // scenario's jobs, which then kept running after the user was told the
          // assistant had been stopped. `null` is how this contract says "all".
          scenarioId: scope.kind === "all" ? null : request.scenarioId,
          closedTurnEpoch,
          signal: window.signal,
        });
      } catch {
        // A canceller that throws has told us nothing, which is exactly the
        // "cancellation could not be confirmed" case -- so it detaches rather than
        // failing the interruption. The gate is already closed either way.
        cancelled.acks = [{ jobId: "unknown", state: "unconfirmed" }];
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

  const diagnostics = summarizeCancellations(cancelled.acks);
  const settlement = classifySettlement({
    timedOut,
    runtime: cancelled.runtime,
    diagnostics,
  });
  // ESTABLISHED FACTS, recorded before the deletion transaction can throw.
  progress.runtime = cancelled.runtime;
  progress.diagnostics = diagnostics;
  progress.settlement = settlement;
  const detached = isDetachedSettlement(settlement);

  // NO EXPLICIT WAIT FOR IN-FLIGHT HISTORY WRITES, and that is a derivation rather
  // than an omission.
  //
  // The terminal `setTurnState` below runs `runFenced` over ASSISTANT_WRITE_TABLES --
  // the SAME four tables, on the same database, as every turn-owned history write. Two
  // `readwrite` transactions with overlapping scope are serialised by IndexedDB in
  // creation order, so a history write already open when we reach here necessarily
  // finishes -- committing or rolling back -- before this settlement transaction can
  // begin. A write that has NOT opened yet starts afterwards and is refused twice
  // over: by the in-memory gate, which closed synchronously when the interruption was
  // requested, and by the durable unsettled-turn comparison inside its own
  // transaction. Clear is the same argument with a wider scope, since its table set is
  // a superset of these.
  //
  // So there is no third case for a drain to cover, and an earlier one here was
  // removed: a mechanism no test can distinguish is a claim, not a guarantee.

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
  progress.settledTurnIds = settledTurnIds;
  progress.fencedTurnIds = fencedTurnIds;

  // ---- 5. Delete after settlement (clear triggers only) ------------------
  let clear: InterruptionResult["clear"] = null;
  if (fence) {
    // BOUNDED RECAPTURE, but ONLY FOR CLEAR ALL.
    //
    // The deletion pass refuses when a generation scope exists that the operation did
    // not capture -- assistant data created after the clear was authorized, which a
    // global wipe must not reach forward into. That refusal is correct, but it is not
    // completion, and publishing it as `cleared` would tell the user their data was
    // deleted while it sat on disk.
    //
    // For Clear all the honest response to a refused deletion is to look again: by
    // this point the gate is closed and the settlement window has passed, so the world
    // should be still. Capture it as it now is and delete that. Bounded, because a
    // recapture that keeps losing the race is a system that is still writing, and
    // looping forever would be worse than saying so.
    //
    // For Clear history a recapture would re-derive its scope from the CURRENT world,
    // and that world may include a same-scenario thread created AFTER this request. The
    // repository's no-reach-forward property promises a thread minted after a clear
    // stays active -- re-fencing it here would break that promise. So a superseded
    // scoped clear returns incomplete and waits for an explicit new click.
    let deletion = await deps.finishClear(fence);
    progress.deletion = deletion;
    let recaptured = fence;
    if (trigger === "clear_all") {
      for (
        let attempt = 0;
        deletion.outcome === "superseded" && attempt < CLEAR_RECAPTURE_LIMIT;
        attempt += 1
      ) {
        recaptured = await deps.beginClear("all", request.scenarioId);
        progress.fence = recaptured;
        deletion = await deps.finishClear(recaptured);
        progress.deletion = deletion;
      }
    }
    clear = { fence: recaptured, deletion };
  }

  // `cleared` ONLY IF THE CONTENT IS ACTUALLY GONE. A clear that was refused for
  // safety stopped the work -- which is `settled` or `detached`, truthfully -- but it
  // did not delete anything, and the surface must not say otherwise.
  const deleted = clear?.deletion.outcome === "deleted";
  const phase: InterruptionPhase = deleted ? "cleared" : detached ? "detached" : "settled";
  deps.publishPhase(phase, trigger);
  recordLifecycleEvent({
    trigger,
    phase,
    at: deps.now(),
    settlement,
    runtime: cancelled.runtime,
    turns: settledTurnIds.length,
    diagnosticsRequested: diagnostics.requested,
    diagnosticsConfirmed: diagnostics.confirmed,
  });

  return {
    trigger,
    closedTurnEpoch,
    runtime: cancelled.runtime,
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
