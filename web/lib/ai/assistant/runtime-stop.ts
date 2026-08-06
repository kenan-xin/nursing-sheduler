"use client";

// What the browser knows about the live run, and how it asks the runtime to end it
// (T05).
//
// WHY AN EXPLICIT STOP CALL AT ALL. `agent.abortRun()` aborts the BROWSER's fetch.
// The Next process's transient runner still holds that run, and the provider call it
// wraps keeps streaming (and billing) with nobody reading it. Only the runtime's
// `agent/stop` route reaches `TransientAgentRunner.stop`, which aborts the provider
// call and erases the run's transient state. The CopilotKit client does not expose
// that route, so the controller calls it directly -- and the route is keyless by
// design (T01), which is what lets Remove key delete the credential BEFORE stopping.
//
// EVERY UNCONFIRMED ANSWER IS A DETACHMENT, never a success. An unknown thread, a
// missing stop target, a restarted process answering under a different instance id,
// and an unreachable runtime all mean the same thing: this app cannot say the run
// stopped. It says Detached instead of synthesising a provider completion.

import { AI_AGENT_ID, AI_RUNTIME_INSTANCE_HEADER, COPILOT_RUNTIME_URL } from "@/lib/ai/protocol";
import type { RuntimeStopOutcome } from "./lifecycle";

/**
 * The live run this tab started, published by the session hook.
 *
 * A module-level handle rather than something the controller reaches into React for:
 * an interruption can be triggered from Settings, from an ownership change, or from
 * the panel, and none of those has the agent instance in scope. `abort` is the
 * agent's own `abortRun`, narrowed to a nullary function so nothing else about the
 * library instance leaks out of the panel.
 */
export interface ActiveRunHandle {
  threadId: string;
  runId: string;
  abort(): void;
}

let activeRun: ActiveRunHandle | null = null;

/** Publish (or clear, with `null`) the run an interruption should target. */
export function setActiveRunHandle(handle: ActiveRunHandle | null): void {
  activeRun = handle;
}

export function readActiveRunHandle(): ActiveRunHandle | null {
  return activeRun;
}

// ---------------------------------------------------------------------------
// Launch-scoped runtime instance
// ---------------------------------------------------------------------------

let instanceId: string | null = null;
let instanceProbe: Promise<string | null> | null = null;

/**
 * The runtime's launch instance id, read once per page lifetime from `/info`.
 *
 * Stamped on every turn so a reload that finds a DIFFERENT id knows the process
 * holding its run is gone. `null` means "not known yet", which detaches rather than
 * guessing -- an unknown instance must never be reported as a matching one.
 */
export function readRuntimeInstanceId(): Promise<string | null> {
  instanceProbe ??= (async () => {
    try {
      const response = await fetch(`${COPILOT_RUNTIME_URL}/info`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      const info = (await response.json()) as { runtimeInstanceId?: unknown };
      return typeof info.runtimeInstanceId === "string" ? info.runtimeInstanceId : null;
    } catch {
      // A handshake failure is not an error to report: the assistant simply has no
      // instance identity to stamp, and every turn prepared without one detaches.
      return null;
    }
  })();
  return instanceProbe;
}

/** The already-resolved instance id, without starting a probe. */
export function peekRuntimeInstanceId(): string | null {
  return instanceId;
}

/** Cache the resolved id so `peek` can answer synchronously during a send. */
export async function primeRuntimeInstanceId(): Promise<string | null> {
  instanceId = await readRuntimeInstanceId();
  return instanceId;
}

/** Test seam: forget the probe so a suite can simulate a restart. */
export function resetRuntimeInstanceForTest(): void {
  instanceId = null;
  instanceProbe = null;
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export interface RuntimeStopRequest {
  threadId: string;
  /** The instance the turn was prepared against, when one was known. */
  runtimeInstanceId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Ask the runtime to stop this thread's run, and classify the answer.
 *
 * Idempotent by construction: the runner reports `stopped: false` for a thread with
 * nothing active, which is a normal `no_active_run` outcome and not a retry signal.
 */
export async function requestRuntimeStop(request: RuntimeStopRequest): Promise<RuntimeStopOutcome> {
  const doFetch = request.fetchImpl ?? globalThis.fetch;
  const url = `${COPILOT_RUNTIME_URL}/agent/${AI_AGENT_ID}/stop/${encodeURIComponent(request.threadId)}`;

  try {
    const response = await doFetch(url, {
      method: "POST",
      // Sent only when known. Omitting it lets the runtime answer for whatever
      // launch is live, which is the right behaviour when this tab never learned an
      // instance id -- the turn detaches on the unknown instance instead.
      headers: request.runtimeInstanceId
        ? { [AI_RUNTIME_INSTANCE_HEADER]: request.runtimeInstanceId }
        : {},
      signal: request.signal,
    });

    // Anything other than a clean 200 is unconfirmed: a 404 (this build's agent id
    // is not the deployed one) and a 500 are both "we cannot say it stopped".
    if (!response.ok) return "unreachable";

    const body = (await response.json()) as { stopped?: unknown; detached?: unknown };
    if (body.detached === true) return "instance_mismatch";
    return body.stopped === true ? "stopped" : "no_active_run";
  } catch {
    // Deliberately no detail kept. A transport error object can carry the request,
    // and the outcome class is the only thing any caller acts on.
    return "unreachable";
  }
}

/**
 * Whether an outcome means the app may claim the run actually stopped.
 *
 * `no_active_run` is deliberately NOT confirmation. It means something else ended
 * the run first and this app does not know what -- which is exactly the case the
 * detachment rule exists for. `not_attempted` is: there was no run to stop.
 */
export function isConfirmedStop(outcome: RuntimeStopOutcome): boolean {
  return outcome === "stopped" || outcome === "not_attempted";
}
