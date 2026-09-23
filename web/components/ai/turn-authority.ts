"use client";

// THE ONE AUTHORITY BOUNDARY for everything that happens after a send is launched.
//
// WHAT WENT WRONG WITHOUT IT. The app owns the launch, which is right: readiness,
// the writer lease, the turn epoch and the durable `preparing` row all have to be
// settled before a byte leaves. But owning the launch meant owning only the FIRST
// hop. CopilotKit drives tool execution and bounded follow-up hops itself, and those
// hops reach the provider without passing back through the app's gate -- so a
// takeover, a Stop, or a commit landing mid-turn could be followed by another
// request. Meanwhile the tool handlers guarded on the turn epoch alone, which misses
// a lease takeover and a document revision entirely.
//
// So there is one bound turn, and two consumers of it:
//
//   * {@link createProviderHopGuard} -- a PUBLIC AG-UI middleware installed on the
//     agent. It sits at the transport boundary, so every hop CopilotKit drives
//     (initial and follow-up alike) passes through it. It rereads the durable writer
//     claim, then performs the synchronous identity check with no await before
//     delegating. A refusal subscribes to nothing: no request is made.
//
//   * {@link assertTurnAuthority} -- the shared before/after guard every tool handler
//     calls. Same comparisons, same source of truth.
//
// The binding is a module singleton rather than React state on purpose. The
// middleware is installed once per agent instance and lives outside the render tree;
// a closure over a render-time value would pin it to whichever turn happened to be
// current when the agent was created.

import { Observable, type Subscription } from "rxjs";
import type { AbstractAgent, BaseEvent, Context, RunAgentInput } from "@ag-ui/client";

import {
  authorizeBoundIdentity,
  claimLaunchAuthority,
  type LaunchLiveInput,
  type SendPlan,
  type SendRefusal,
} from "@/lib/ai/assistant/send-gate";
import { readWriterContext, type WriterContext } from "@/lib/ai/assistant/writer-context";

/**
 * What a handler answers once its turn is no longer the current one.
 *
 * A string rather than a throw: a thrown tool error reads to the model as a failure
 * worth retrying, while this says plainly that there is nothing to answer. Defined
 * here so all four tool modules share one wording.
 */
export const SUPERSEDED =
  "superseded: this request belongs to an interrupted turn and was not answered.";

/**
 * The immutable identity of one authorised top-level turn.
 *
 * WHY A TOKEN AND NOT "whatever is bound right now". The binding is a slot, and a
 * suspended callback from turn A can resume after turn B has taken that slot. Asking
 * "is a turn bound?" would then let A authenticate as B -- and act, publish, or tear
 * down B's state under B's authority. So a callback captures the token it began under
 * and every later check demands that SAME token, by identity. A resuming under B
 * fails at the first comparison, before any effect.
 *
 * Object identity is the comparison. The fields are here because they make a failed
 * check legible in a test or a log, not because equality is computed from them.
 */
export interface TurnToken {
  /** The concrete agent instance this turn runs on. */
  readonly agent: object;
  readonly threadId: string;
  readonly scenarioId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly turnEpoch: number;
}

export interface BoundTurn {
  /** This turn's immutable identity. Captured by every callback that may resume. */
  readonly token: TurnToken;
  readonly plan: SendPlan;
  /** The thread the panel that launched this turn is bound to. */
  readonly boundThreadId: string;
  /** Samples every live authority fact without an await. */
  readonly liveNow: () => LaunchLiveInput;
  /**
   * The most recent durable writer claim.
   *
   * Refreshed by the hop guard on every hop, which is what lets a tool handler check
   * the LEASE EPOCH synchronously: the live projection does not carry it, and making
   * every handler open a Dexie transaction would put a durable read in front of every
   * tool call for a fact that only a hop can change.
   */
  claim: WriterContext;
  /**
   * Every provider run this turn owns: the top-level one, plus each follow-up hop
   * CopilotKit mints as it drives tool results back to the model.
   *
   * AG-UI hands every subscriber the concrete `input` for the run that produced an
   * event, and this is what a callback compares it against. Filtering on the
   * TOP-LEVEL run id alone would drop every follow-up -- including the hop that
   * carries the actual answer -- so ownership is a set the hop guard extends as it
   * authorises each hop.
   */
  readonly ownedRunIds: Set<string>;
  /**
   * Set once, by whichever guard refuses first.
   *
   * The run that follows a refusal ends without events, and the session must settle it
   * with the REASON rather than as a generic transport failure -- "your takeover
   * stopped this" and "the provider broke" are different things to tell a nurse.
   */
  refusal: SendRefusal | null;
}

let bound: BoundTurn | null = null;

/**
 * How many turns have EVER been bound in this page lifetime.
 *
 * Not the turn epoch: an interruption bumps that without any new turn existing, which
 * cannot distinguish "the user's send was revoked while they waited" (they need the
 * explanation) from "they stopped, asked again, and got an answer" (an explanation for
 * the abandoned send would land on top of the new one). Only a launch increments this.
 */
let bindings = 0;

/** Bind the turn every later hop and tool will be checked against. */
export function bindTurn(turn: BoundTurn): void {
  bound = turn;
  bindings += 1;
  // A launch claims the visible list too: from here the new turn's mirror owns what
  // the user sees, so any read already in flight for an older turn is stale.
  claimVisibleWrite();
}

/** See {@link bindings}. Compare a captured value to detect a newer launch. */
export function boundTurnGeneration(): number {
  return bindings;
}

/**
 * How many times anything has written the panel's VISIBLE message list.
 *
 * WHY OWNERSHIP OF THE VISIBLE LIST NEEDS ITS OWN COUNTER. Hydration and the
 * post-settlement reconcile both read disk and then publish what they read. Between
 * those two steps a newer turn can launch, mirror a tool result, answer and settle --
 * and the read, resolving late, would replace all of it with an older snapshot. The
 * obvious guard, "is the panel agent running?", is the wrong question twice over: the
 * run happens on a per-turn CLONE, so the panel agent is idle throughout, and by the
 * time a slow read resolves the newer turn may have finished anyway.
 *
 * So a read captures this before its await and demands the same value before it
 * publishes. Monotonic and module-scoped on purpose: it has to outlive the hook
 * instance, because a remount is one of the ways a newer turn takes the list over.
 */
let visibleWrites = 0;

/** Record a write to the panel's visible list. Returns the new revision. */
export function claimVisibleWrite(): number {
  return (visibleWrites += 1);
}

/** The current visible revision. Capture before an await, compare before publishing. */
export function readVisibleRevision(): number {
  return visibleWrites;
}

/**
 * Release a binding, but only if it is still the current one.
 *
 * Scoped rather than unconditional: a turn's `finally` can run after a newer turn has
 * already bound itself, and clearing that one would leave the newer turn unguarded --
 * which, because an absent binding refuses, would look like an unexplained refusal.
 */
export function releaseTurn(turn: BoundTurn): void {
  if (bound === turn) bound = null;
}

/** The currently bound turn, or `null` when the app has authorised none. */
export function readBoundTurn(): BoundTurn | null {
  return bound;
}

/** Test seam: drop any binding left by a failed test. */
export function resetTurnAuthorityForTest(): void {
  bound = null;
}

/**
 * The token a callback should capture as it BEGINS, before its first await.
 *
 * `null` means no turn is authorised, which is itself a refusal: a handler reached
 * from outside an authorised turn has no authority by construction.
 */
export function currentTurnToken(): TurnToken | null {
  return bound?.token ?? null;
}

/**
 * The shared tool guard. Call it before starting and after every await.
 *
 * Returns the superseded answer when this handler may no longer speak, and `null`
 * when it may. Covers the abort signal, the presence of a bound turn at all, and
 * every identity fact {@link authorizeBoundIdentity} compares: scenario, thread, turn
 * and run identity, the turn epoch, the lease epoch and the bound document revision.
 */
export function assertTurnAuthority(token: TurnToken | null, signal?: AbortSignal): string | null {
  if (signal?.aborted) return SUPERSEDED;
  const turn = readBoundTurn();
  // No binding means no turn the app authorised.
  if (!turn) return SUPERSEDED;
  // THE TOKEN COMPARISON, and it must come before everything else: a caller that
  // began under a different turn is not entitled to this one's answer, however
  // healthy this one happens to be.
  if (token === null || turn.token !== token) return SUPERSEDED;
  if (turn.refusal) return SUPERSEDED;
  const verdict = authorizeBoundIdentity({ ...turn.liveNow(), claim: turn.claim });
  return verdict.ok ? null : SUPERSEDED;
}

/** `true` when the captured turn may still act. The predicate form of the guard. */
export function isTurnAuthorized(token: TurnToken | null, signal?: AbortSignal): boolean {
  return assertTurnAuthority(token, signal) === null;
}

export interface ProviderHopGuardDeps {
  /** Durable writer reread. Injected so the guard is testable without Dexie. */
  readWriterContext?: () => Promise<WriterContext | null>;
  /**
   * The approved snapshot, injected into EVERY hop's run input.
   *
   * Carried here rather than registered in CopilotKit's context store because that
   * store is keyed by `agentId`, and a per-turn clone keeps its parent's agent id --
   * so two live turns' contexts would coexist under the same key and a follow-up
   * could be built from the wrong document. Run input is per-hop by construction,
   * which is the isolation the store cannot give.
   */
  context?: readonly Context[];
}

/**
 * The transport-boundary guard, as a public AG-UI middleware.
 *
 * Installed with `agent.use(...)`, so CopilotKit's own run handler cannot reach the
 * HTTP agent without passing through it -- which is the point: the follow-up hops are
 * CopilotKit's to drive, and this is the only place the app can still stand between
 * them and the network.
 */
export function createProviderHopGuard(agent: object, deps: ProviderHopGuardDeps = {}) {
  const readWriter = deps.readWriterContext ?? readWriterContext;

  return (input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> =>
    new Observable<BaseEvent>((subscriber) => {
      const turn = readBoundTurn();
      // Zero requests when nothing is authorised, or when the bound turn belongs to a
      // DIFFERENT agent than the one this guard was installed on. Completing rather
      // than erroring: there is no failure to report, the run simply produces nothing.
      if (!turn || turn.token.agent !== agent) {
        subscriber.complete();
        return;
      }
      // Captured before the first await, and demanded again after it.
      const token = turn.token;

      let cancelled = false;
      let delegated: Subscription | undefined;

      const refuse = (reason: SendRefusal) => {
        turn.refusal ??= reason;
        subscriber.complete();
      };

      void (async () => {
        // The durable reread, exactly as the launch does it.
        const claim = await claimLaunchAuthority(turn.plan, { readWriterContext: readWriter });
        if (cancelled) return;
        // The slot may have changed hands across that await. Writing `turn.claim` or
        // delegating now would be this hop acting under whoever holds it.
        if (readBoundTurn()?.token !== token) {
          subscriber.complete();
          return;
        }
        if (!claim.ok) {
          refuse(claim.reason);
          return;
        }
        turn.claim = claim.writer;

        // NO `await` BETWEEN HERE AND `next.run`, deliberately -- the same contract the
        // launch keeps. The interruption controller closes its gate synchronously and a
        // commit publishes to the authority projection synchronously, so a check with
        // no microtask boundary after it cannot be overtaken by either.
        const verdict = authorizeBoundIdentity({ ...turn.liveNow(), claim: claim.writer });
        if (!verdict.ok) {
          refuse(verdict.reason);
          return;
        }

        // This hop now belongs to the turn, so its subscriber callbacks are ours to
        // honour. Recorded BEFORE delegating: the first event can arrive in the same
        // tick, and a callback that could not identify its own run would have to
        // either trust every run or drop its own.
        turn.ownedRunIds.add(input.runId);

        // The approved snapshot rides the run input. Replaced rather than merged: the
        // context this turn was authorised under is the whole context it may send.
        const authorizedInput = deps.context ? { ...input, context: [...deps.context] } : input;
        delegated = next.run(authorizedInput).subscribe(subscriber);
      })();

      return () => {
        cancelled = true;
        delegated?.unsubscribe();
      };
    });
}
