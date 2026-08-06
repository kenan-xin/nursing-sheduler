// LOAD-BEARING: must precede the `@copilotkit/runtime` import (see containment.ts).
import { RUNTIME_INSTANCE_HEADER } from "./containment";

import type { BaseEvent } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Observable, type Subscriber, type Subscription } from "rxjs";

// Transient AgentRunner (tech-plan "Runtime retention and observability").
//
// CopilotKit's default `InMemoryAgentRunner` retains thread history in process
// memory after a run settles, which would make the Next process a server-side
// transcript store. `AgentRunner` is the library's own supported replacement seam,
// so this is an implementation of a public abstract class -- not a shim over
// internals.
//
// The contract this narrows to:
//   - the map holds ONLY currently-active runs;
//   - `connect` attaches only to a currently-active run on THIS launch instance;
//   - `stop` aborts that run and reports whether it found one (idempotent);
//   - completion, error, stop settlement, and detachment erase the entry AND its
//     buffered events, so no terminal thread list or replay survives.

type ActiveRun = {
  readonly threadId: string;
  readonly runId: string;
  readonly agent: AgentRunnerRunRequest["agent"];
  /** Live replay buffer for the current run only. Erased on terminal settlement. */
  events: BaseEvent[];
  readonly subscribers: Set<Subscriber<BaseEvent>>;
  upstream?: Subscription;
  settled: boolean;
};

export type TransientAgentRunnerOptions = {
  /** Launch-scoped instance id this runner belongs to. */
  instanceId: string;
};

/** Bounded, non-content settlement classes. Safe to log; carries no run content. */
export type SettlementReason = "completed" | "errored" | "stopped" | "superseded" | "detached";

export class TransientAgentRunner extends AgentRunner {
  readonly instanceId: string;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: TransientAgentRunnerOptions) {
    super();
    this.instanceId = options.instanceId;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent, input } = request;

    // A new send supersedes any run still active on the same thread. Replacing
    // rather than rejecting keeps the browser's one-turn-per-thread model true
    // even if a prior response stream was abandoned without a stop. Aborting is
    // load-bearing: unsubscribing alone would leave the superseded provider call
    // streaming (and billing) with nobody reading it.
    this.terminate(threadId, "superseded");

    const entry: ActiveRun = {
      threadId,
      runId: input.runId,
      agent,
      events: [],
      subscribers: new Set(),
      settled: false,
    };
    this.active.set(threadId, entry);

    // `agent.run()` emits RUN_STARTED synchronously on subscribe, before the HTTP
    // consumer subscribes to the observable returned below. Buffering here and
    // replaying at subscribe time is what keeps that first event from being lost.
    entry.upstream = agent.run(input).subscribe({
      next: (event) => {
        if (entry.settled) return;
        entry.events.push(event);
        // Snapshot deliberately: a Set iterator is live, so a `connect` arriving
        // mid-dispatch would be added to the set and then receive this event a
        // second time on top of the buffer replay it already got.
        // oxlint-disable-next-line no-useless-spread
        for (const subscriber of [...entry.subscribers]) subscriber.next(event);
      },
      error: (error: unknown) => {
        const subscribers = this.settle(threadId, "errored", entry);
        for (const subscriber of subscribers) subscriber.error(error);
      },
      complete: () => {
        const subscribers = this.settle(threadId, "completed", entry);
        for (const subscriber of subscribers) subscriber.complete();
      },
    });

    return this.attach(entry);
  }

  /**
   * Attach to a currently-active run. Anything else -- unknown thread, cleared
   * thread, already-settled run, a run belonging to a different launch instance --
   * yields an EMPTY stream that completes immediately. No 404, no server history,
   * no replay of another thread, no model retry: the browser reads the empty
   * settlement as "detached" and requires a fresh send.
   */
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const claimedInstance = readHeader(request.headers, RUNTIME_INSTANCE_HEADER);
    if (claimedInstance !== undefined && claimedInstance !== this.instanceId) {
      return EMPTY_EVENTS;
    }

    const entry = this.active.get(request.threadId);
    if (!entry || entry.settled) return EMPTY_EVENTS;

    return this.attach(entry);
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const entry = this.active.get(request.threadId);
    return Promise.resolve(entry !== undefined && !entry.settled);
  }

  /**
   * Idempotent. `false` is a valid detached settlement, not an error: a missing
   * run, an already-stopped run, or a stop aimed at a superseded run all report
   * `false` and change nothing.
   */
  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const entry = this.active.get(request.threadId);
    if (!entry || entry.settled) return Promise.resolve(false);

    // Never stop a newer run on the same thread.
    if (request.runId !== undefined && request.runId !== entry.runId) return Promise.resolve(false);

    this.terminate(request.threadId, "stopped");
    return Promise.resolve(true);
  }

  /**
   * App-initiated detachment (takeover, Clear, Disable). Erases the run's transient
   * state exactly like a terminal settlement.
   */
  detach(threadId: string): boolean {
    const entry = this.active.get(threadId);
    if (!entry || entry.settled) return false;

    this.terminate(threadId, "detached");
    return true;
  }

  /**
   * Non-terminal-from-the-model's-side settlement: abort the provider call, erase
   * the transient state, and complete attached consumers.
   */
  private terminate(threadId: string, reason: SettlementReason): void {
    const entry = this.active.get(threadId);
    if (!entry || entry.settled) return;

    entry.agent.abortRun();
    const subscribers = this.settle(threadId, reason, entry);
    for (const subscriber of subscribers) subscriber.complete();
  }

  /** Bounded observability: how many runs are currently active. Never their content. */
  activeRunCount(): number {
    return this.active.size;
  }

  private attach(entry: ActiveRun): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      // Replay only what this still-active run has emitted so far.
      for (const event of entry.events) subscriber.next(event);

      if (entry.settled) {
        subscriber.complete();
        return;
      }

      entry.subscribers.add(subscriber);
      return () => {
        entry.subscribers.delete(subscriber);
      };
    });
  }

  /**
   * Terminal erasure. Removes the map entry, drops the buffered events, and
   * unsubscribes upstream. Returns the subscribers that were attached so the
   * caller can deliver the matching terminal signal AFTER state is already gone --
   * a late `connect` racing the settlement therefore finds nothing to replay.
   */
  private settle(
    threadId: string,
    reason: SettlementReason,
    expected?: ActiveRun,
  ): Subscriber<BaseEvent>[] {
    const entry = this.active.get(threadId);
    if (!entry || (expected && entry !== expected) || entry.settled) return [];

    entry.settled = true;
    this.active.delete(threadId);

    const subscribers = [...entry.subscribers];
    entry.subscribers.clear();
    entry.events = [];

    if (reason !== "completed" && reason !== "errored") entry.upstream?.unsubscribe();
    entry.upstream = undefined;

    return subscribers;
  }
}

/** Completes immediately with zero events. */
const EMPTY_EVENTS = new Observable<BaseEvent>((subscriber) => {
  subscriber.complete();
});

// CopilotKit lowercases forwarded header keys, but a `Record<string, string>` from
// another caller need not, so match case-insensitively rather than trusting casing.
function readHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
