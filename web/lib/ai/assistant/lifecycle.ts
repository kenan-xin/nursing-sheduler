// The bounded interruption vocabulary and the lifecycle log (T05, tech-plan
// "Strict interruption, settlement, and detachment").
//
// EVERY string in this file is a CLASS, never a value. That is the whole reason it
// exists as its own module: the privacy boundary allows "bounded metadata such as
// request ID, model ID, latency, ... settlement state, and error class" and nothing
// else, and the most reliable way to honour that is for the log's record type to be
// unable to hold anything but members of these unions. There is no `message`,
// `detail`, `payload`, or `cause` field to accidentally fill with a prompt, a
// scenario, a tool argument, a model output, a credential, or an upstream body.
//
// The log is IN-MEMORY and bounded to {@link LIFECYCLE_LOG_LIMIT} entries. It is
// operational evidence for the current page lifetime -- deliberately not a durable
// table, because a durable interruption trail would be a second thing Clear all had
// to delete, and it carries nothing worth surviving a reload.

/**
 * Every action that must close local assistant authority.
 *
 * One list, one controller. The tech plan is explicit that Stop, Disable,
 * Remove/Replace configuration, Clear history, Clear all, and takeover must not
 * grow separate partial cancellation paths, and `scenario_switch`/`lease_lost` are
 * here for the same reason: they invalidate exactly the same in-flight work.
 */
export const INTERRUPTION_TRIGGERS = [
  /** The user pressed Stop during a reply. */
  "stop",
  /** The AI master switch was turned off. */
  "disable",
  /** The stored credential was deleted. */
  "remove_key",
  /** A new key/model pair is being probed and activated. */
  "replace_configuration",
  /** This scenario's conversation is being cleared. */
  "clear_history",
  /** Every local AI setting, credential and conversation is being cleared. */
  "clear_all",
  /** The selected scenario identity changed under an open panel. */
  "scenario_switch",
  /** This tab's writer lease lapsed. */
  "lease_lost",
  /** Another tab took over scenario editing. */
  "takeover",
] as const;

export type InterruptionTrigger = (typeof INTERRUPTION_TRIGGERS)[number];

/**
 * Where an interruption currently is. Ordered, and the panel renders it verbatim:
 * `closing` and `cancelling` are the "Stopping" face, `settling` is "Waiting for
 * cancellation", and the last three are terminal.
 */
export type InterruptionPhase =
  | "closing"
  | "cancelling"
  | "settling"
  | "settled"
  | "detached"
  | "cleared";

/** What the same-origin runtime said about the stop request. */
export type RuntimeStopOutcome =
  /** The runtime found this thread's run and aborted it. */
  | "stopped"
  /** Nothing was running: unknown thread, already settled, superseded run. */
  | "no_active_run"
  /** The process answering is not the launch that started the run. */
  | "instance_mismatch"
  /** The runtime could not be reached, or answered unusably. */
  | "unreachable"
  /** No stop was attempted, because no run had been started. */
  | "not_attempted";

/**
 * How a turn ended. This is the value stored in `AssistantTurnV1.terminalReason`,
 * and the panel's wording is derived from it plus the trigger -- never from a
 * provider or transport error object.
 *
 * The `detached_*` members are the honest answer to "we do not know": the app never
 * synthesises a provider completion for work it could not confirm.
 */
export type AssistantSettlement =
  /** The provider run finished normally. */
  | "completed"
  /** The transport or provider failed. No terminal provider result exists. */
  | "run_failed"
  /** Interruption confirmed: the runtime acknowledged stopping the run. */
  | "stopped"
  /** Interruption confirmed AND an owned diagnostic confirmed terminal cancellation. */
  | "cancelled"
  /** The 15-second settlement window elapsed with work still unacknowledged. */
  | "detached_timeout"
  /** Runtime restart, unknown thread, missing stop target, or instance mismatch. */
  | "detached_runtime"
  /** A previous page lifetime left this turn mid-flight. */
  | "detached_reload"
  /**
   * Authority for the turn was revoked before the provider was ever contacted.
   *
   * Deliberately NOT a `detached_*` member: a detachment means "we cannot say what
   * happened", while this one is fully known -- an interruption, an ownership or
   * identity change, or a competing submit closed this turn's authority during
   * preparation and nothing was ever sent. See the final launch authorization in
   * `./send-gate`.
   */
  | "revoked";

/**
 * Every settlement value, as data.
 *
 * The union above is erased at runtime, and a durable Clear fact record has to be able
 * to REFUSE a settlement it does not recognise -- a parser that trusted whatever
 * string a row carried would let a future or corrupted build's vocabulary through into
 * bounded product state. One list, so the type and the guard cannot drift.
 */
export const ASSISTANT_SETTLEMENTS = [
  "completed",
  "run_failed",
  "stopped",
  "cancelled",
  "detached_timeout",
  "detached_runtime",
  "detached_reload",
  "revoked",
] as const satisfies readonly AssistantSettlement[];

/** Whether an arbitrary value is one of this build's settlement classes. */
export function isAssistantSettlement(value: unknown): value is AssistantSettlement {
  return (ASSISTANT_SETTLEMENTS as readonly unknown[]).includes(value);
}

/** Whether a settlement class is a detachment rather than a confirmed outcome. */
export function isDetachedSettlement(settlement: AssistantSettlement): boolean {
  return settlement.startsWith("detached_");
}

/** The clear triggers -- the two that bump a write generation and delete content. */
export function isClearTrigger(trigger: InterruptionTrigger): boolean {
  return trigger === "clear_history" || trigger === "clear_all";
}

// ---------------------------------------------------------------------------
// User-facing wording
// ---------------------------------------------------------------------------

/**
 * What the panel says while an interruption is still in progress.
 *
 * Never "cancelled": until a terminal acknowledgement or the bounded timeout, the
 * honest claim is that cancellation has been REQUESTED. Claiming otherwise would tell
 * a nurse a background check had stopped when it may still be running.
 */
export function describeInterruptionPhase(phase: InterruptionPhase): string {
  switch (phase) {
    case "closing":
    case "cancelling":
      return "Stopping…";
    case "settling":
      return "Stopping. Waiting for the assistant, and anything it started, to confirm.";
    case "cleared":
      return "Clearing this conversation…";
    case "settled":
    case "detached":
      return "Stopped.";
  }
}

/**
 * What the panel says once a turn has ended. Derived from the bounded settlement
 * class and the trigger -- never from a provider or transport error, which may carry
 * request content and would mean nothing to the reader anyway.
 *
 * Every message states the same two facts the user actually needs: what is kept, and
 * that their schedule was not changed.
 */
export function describeSettlement(
  settlement: AssistantSettlement,
  trigger: InterruptionTrigger | null,
): string {
  const kept = "Anything already shown is kept, and nothing in your schedule was changed.";

  switch (settlement) {
    case "completed":
      return "";
    case "stopped":
      return trigger === "takeover"
        ? `Another tab took over editing, so the reply was stopped. ${kept}`
        : trigger === "lease_lost"
          ? `This tab stopped editing the schedule, so the reply was stopped. ${kept}`
          : `Stopped. ${kept}`;
    case "cancelled":
      return `Stopped, and the checks it had started were cancelled. ${kept}`;
    case "detached_timeout":
      return (
        "Stopped here, but cancellation could not be confirmed within 15 seconds, so a " +
        `background check may still finish on its own. Its result will not be used. ${kept}`
      );
    case "detached_runtime":
      return `That reply stopped before it finished and could not be confirmed. ${kept}`;
    case "detached_reload":
      return `That reply stopped when the page reloaded. ${kept} Send again to retry.`;
    case "run_failed":
      return `That reply could not be completed. ${kept} Send again to retry.`;
    case "revoked":
      return (
        "That message was not sent: the assistant's setup, this schedule, or this tab's " +
        `editing access changed while it was being prepared. ${kept} Send again to retry.`
      );
  }
}

// ---------------------------------------------------------------------------
// Bounded lifecycle log
// ---------------------------------------------------------------------------

/**
 * One bounded lifecycle fact. Note what is absent: no free text of any kind.
 *
 * `errorClass` is a fixed classification, not a caught error's message -- an
 * upstream body or a transport error object may carry request content, so it is
 * classified at the boundary and discarded there.
 */
export interface AssistantLifecycleEvent {
  seq: number;
  at: string;
  /**
   * The interruption that caused this, or `null` when nothing did.
   *
   * Nullable for the same reason `LastSettlement.trigger` is: a storage or transport
   * failure ends work without any user action, and attributing it to Stop would
   * misreport what happened.
   */
  trigger: InterruptionTrigger | null;
  phase: InterruptionPhase;
  settlement: AssistantSettlement | null;
  runtime: RuntimeStopOutcome | null;
  /** How many turns this phase settled locally. A count, never their content. */
  turns: number;
  /** How many owned diagnostic jobs were asked to cancel, and how many confirmed. */
  diagnosticsRequested: number;
  diagnosticsConfirmed: number;
  errorClass: AssistantErrorClass | null;
}

/** The complete set of failure classifications this app will ever log. */
export type AssistantErrorClass =
  | "generation_fenced"
  | "runtime_unreachable"
  | "storage_unavailable"
  | "diagnostic_cancel_failed"
  /** A queued conversation write was rejected. The class only -- never the error. */
  | "persist_failed"
  /** Clear stopped the work but refused to delete; the content is still on disk. */
  | "clear_incomplete";

/** How many entries the in-memory log retains. Oldest are dropped. */
export const LIFECYCLE_LOG_LIMIT = 50;

let log: AssistantLifecycleEvent[] = [];
let seq = 0;

export interface RecordLifecycleInput {
  trigger: InterruptionTrigger | null;
  phase: InterruptionPhase;
  at: Date;
  settlement?: AssistantSettlement | null;
  runtime?: RuntimeStopOutcome | null;
  turns?: number;
  diagnosticsRequested?: number;
  diagnosticsConfirmed?: number;
  errorClass?: AssistantErrorClass | null;
}

/** Append one bounded lifecycle fact, dropping the oldest past the limit. */
export function recordLifecycleEvent(input: RecordLifecycleInput): AssistantLifecycleEvent {
  seq += 1;
  const event: AssistantLifecycleEvent = {
    seq,
    at: input.at.toISOString(),
    trigger: input.trigger,
    phase: input.phase,
    settlement: input.settlement ?? null,
    runtime: input.runtime ?? null,
    turns: input.turns ?? 0,
    diagnosticsRequested: input.diagnosticsRequested ?? 0,
    diagnosticsConfirmed: input.diagnosticsConfirmed ?? 0,
    errorClass: input.errorClass ?? null,
  };
  log.push(event);
  if (log.length > LIFECYCLE_LOG_LIMIT) log = log.slice(-LIFECYCLE_LOG_LIMIT);
  return event;
}

/** The retained lifecycle facts, oldest first. */
export function readLifecycleLog(): readonly AssistantLifecycleEvent[] {
  return log;
}

/** Drop the log. Called by Clear all and by tests. */
export function resetLifecycleLog(): void {
  log = [];
}
