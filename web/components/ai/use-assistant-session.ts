"use client";

// The browser turn controller (T04, tech-plan "CopilotKit UI and browser
// controller").
//
// This hook is why the app composes CopilotKit's prebuilt view primitives rather
// than the high-level `CopilotChat`: submission has to be the APP's, because the
// app is the only thing that can check readiness, acquire the writer lease, reread
// the persisted envelope, hydrate local history, mint the turn epoch and persist a
// `preparing` turn -- all before a single byte reaches the provider.
//
// MOUNTING COSTS NOTHING PROVIDER-SIDE. Everything here is local until `send` is
// called explicitly: the agent instance is constructed, tools are registered, and
// history is hydrated from IndexedDB. The welcome state is app content. There is no
// initial run, and no `connect` — which is exactly why the panel can be opened by a
// user who then changes their mind at zero cost.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { useAssistantTurnRunner } from "./copilotkit-core-access";
import type { AgentSubscriber, Message } from "@ag-ui/client";
import { AI_AGENT_ID } from "@/lib/ai/protocol";
import {
  persistThreadMessages,
  readThread,
  readThreadMessages,
  readTurn,
  recordPreparingTurn,
  scrubThreadHistory,
  selectActiveThread,
  setTurnState,
  settleTurnIfUnsettled,
} from "@/lib/ai/assistant/history-repo";
import { completeToolPairs, freezeMessages, toTransportThread } from "@/lib/ai/assistant/messages";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";

/**
 * Write the panel's visible list and record that the list changed.
 *
 * Every publication goes through here so `readVisibleRevision` is a complete record of
 * visible ownership; a bare `setMessages` would be invisible to the reads that fence
 * against it.
 */
function publishVisible(
  agent: { setMessages: (messages: Message[]) => void },
  messages: Message[],
) {
  agent.setMessages(messages);
  claimVisibleWrite();
}

/**
 * Publish an async read's result, but only if nothing has claimed the list since.
 *
 * COMPARE AND CLAIM IN ONE STEP, with no await between them -- which is what makes two
 * reads captured at the same revision unable to both publish: the first advances the
 * revision as it writes, so the second's comparison fails. Splitting the check from the
 * write would leave exactly the gap this exists to close.
 */
function publishVisibleIfOwned(
  agent: { setMessages: (messages: Message[]) => void },
  messages: Message[],
  owned: number,
): boolean {
  if (readVisibleRevision() !== owned) return false;
  publishVisible(agent, messages);
  return true;
}
import { buildAssistantContext } from "@/lib/ai/assistant/scenario-context";
import {
  authorizeLaunchAuthority,
  authorizeLaunchIdentity,
  claimLaunchAuthority,
  prepareSend,
  type LaunchLiveInput,
  type SendRefusal,
} from "@/lib/ai/assistant/send-gate";
import {
  peekRuntimeInstanceId,
  primeRuntimeInstanceId,
  clearActiveRunHandle,
  readActiveRunHandle,
  setActiveRunHandle,
} from "@/lib/ai/assistant/runtime-stop";
import { recordLifecycleEvent } from "@/lib/ai/assistant/lifecycle";
import {
  assistantActions,
  hasLiveAssistantWork,
  isInterrupting,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
import { readWriterContext } from "@/lib/ai/assistant/writer-context";
import { useAuthorityStore } from "@/lib/store";
import { useModelVisibleTools } from "./use-context-tools";
import {
  bindTurn,
  boundTurnGeneration,
  claimVisibleWrite,
  createProviderHopGuard,
  readVisibleRevision,
  isTurnAuthorized,
  releaseTurn,
  type BoundTurn,
} from "./turn-authority";

/** The local registry id for this thread's private proxied agent. */
export function localAgentId(threadId: string): string {
  return `${AI_AGENT_ID}:${threadId}`;
}

/** Agents that already carry the provider-hop guard. See the effect that fills it. */
const guardedAgents = new WeakSet<object>();

export interface AssistantSessionInput {
  threadId: string;
  /** Current route, attached as turn context. */
  routePath: string;
  routeLabel: string | null;
  /**
   * A historical thread renders read-only: no send, no live tool authority. The
   * caller decides this from the thread's own state and this tab's ownership.
   */
  historical: boolean;
}

/**
 * What a live turn is doing, for the panel's status line. `null` when there is nothing
 * to say: no live turn, or reply text is already streaming onto the screen.
 */
export type AssistantActivity = { kind: "thinking" } | { kind: "tool"; name: string } | null;

const THINKING: AssistantActivity = { kind: "thinking" };

/**
 * Read the turn's activity from the CLONE's raw list, not the published one: the
 * published view drops an unanswered tool call (see `completeToolPairs`), and an
 * unanswered call is exactly the one that is running.
 */
function describeTurnActivity(messages: readonly Message[]): AssistantActivity {
  const answered = new Set(
    messages.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
  );
  const running = messages
    .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
    .filter((call) => !answered.has(call.id))
    .at(-1);
  if (running) return { kind: "tool", name: running.function.name };
  const last = messages.at(-1);
  if (last?.role === "assistant" && typeof last.content === "string" && last.content.trim()) {
    return null;
  }
  return THINKING;
}

export interface AssistantSession {
  messages: Message[];
  isRunning: boolean;
  /** What the live turn is doing right now; see {@link AssistantActivity}. */
  activity: AssistantActivity;
  /** True until the agent instance is the real runtime-synced one. */
  connecting: boolean;
  /** True while an interruption has closed the gate and has not settled. */
  interrupting: boolean;
  /** A send is in flight, from prepare until its last write settles. */
  sending: boolean;
  /**
   * Resolves false only when refused before preparing: a historical conversation, or
   * a send already in flight. Refusals during preparation or launch are published
   * through the store and still resolve true.
   */
  send(text: string): Promise<boolean>;
  stop(): void;
}

export function useAssistantSession(input: AssistantSessionInput): AssistantSession {
  const agentId = localAgentId(input.threadId);
  // THE PANEL CORE'S PUBLIC CONFIGURATION, AS DATA -- never the core itself.
  //
  // This hook used to hold the whole mutable core. Everything below reads from it; the
  // run happens on a core this turn constructs. But holding it meant one line of
  // ordinary-looking code could `setTools` a live handler out from under the registry --
  // preserving name, agent and schema while removing the authority check and the host
  // parse, invisibly to every registry proof. `./copilotkit-core-access` hands over the
  // configuration and keeps the capability.
  const createTurnRunner = useAssistantTurnRunner();

  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: AI_AGENT_ID,
    threadId: input.threadId,
    // Re-render on message and run-status changes; a 60ms window keeps a fast token
    // stream from re-rendering the whole transcript per chunk.
    updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged],
    throttleMs: 60,
  });

  // The AUTHORISED epoch, not the live one -- see the two-epoch note in
  // `lib/ai/assistant/store.ts`. Registering tools against the live epoch would let
  // the guard re-equalise (live === registered) on the first re-render after an
  // interruption bumped it, quietly reopening the tool gate. `-1` can never equal a
  // live epoch, so an unauthorised state stays closed however often this re-renders.
  const authorizedTurnEpoch = useAssistantStore((state) => state.authorizedTurnEpoch);
  useModelVisibleTools(agentId, authorizedTurnEpoch ?? -1);

  // THE TRANSPORT-BOUNDARY GUARD, installed once per agent instance.
  //
  // `use()` appends to the agent's middleware chain and AG-UI offers no removal, so
  // re-installing on every render would stack duplicate guards on one agent. The
  // WeakSet keys off the agent itself, so a new agent instance (a thread switch, a
  // runtime-synced swap) gets its own guard and a discarded one is collectable.
  //
  // Installed in an EFFECT rather than during render because `use()` mutates the
  // agent, and it closes over NOTHING from this render: the guard reads the bound turn
  // from the module singleton, which is what lets one long-lived middleware police
  // whichever turn is current.
  useEffect(() => {
    if (guardedAgents.has(agent)) return;
    guardedAgents.add(agent);
    agent.use(createProviderHopGuard(agent));
  }, [agent]);

  const interrupting = useAssistantStore((state) => state.interruption !== null);
  // The app's own answer to "is a turn live?", covering preparation as well as the
  // run: a turn one await from the provider is exactly as interruptible as a
  // streaming one, and the user must be able to stop it.
  const liveTurn = useAssistantStore(hasLiveAssistantWork);
  // Written only by the authorized turn's own callbacks, and only shown while a turn is
  // live, so a detached turn's late events cannot relabel the current one.
  const [turnActivity, setTurnActivity] = useState<AssistantActivity>(THINKING);

  // Hydration. Runs per (real) agent instance: `useAgent` swaps `agent` for the
  // runtime-synced instance once `/info` resolves, and a provisional instance that
  // was hydrated would lose those messages on the swap.
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady) return;
    const key = `${input.threadId}:${agent.agentId ?? ""}`;
    if (hydratedFor.current === key) return;
    hydratedFor.current = key;

    let cancelled = false;
    // Captured BEFORE the await. See `readVisibleRevision`: a newer turn can launch,
    // mirror, answer and settle while this read is in flight, and publishing then
    // would replace its conversation with an older snapshot of disk.
    const owned = readVisibleRevision();
    void readThreadMessages(input.threadId).then((records) => {
      if (cancelled) return;
      // NORMALIZED ON THE WAY IN, not only on the way out. A dangling row already on
      // disk would otherwise reach the visible panel and, through the next send's
      // history, the provider -- before any publication filter could run.
      publishVisibleIfOwned(agent, completeToolPairs(toTransportThread(records)), owned);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, isReady, input.threadId]);

  // RECONCILED WITH DISK ONCE AN INTERRUPTION SETTLES.
  //
  // The visible list is mirrored at authorized boundaries, and a boundary that was
  // authorized when it published can still have its WRITE rolled back afterwards --
  // a turn revoked inside its own transaction leaves nothing durable, by design. What
  // is left is a panel showing a tool call and an answer that disk does not have, so a
  // reload would silently delete them in front of the user, and the next send would
  // build its history from a different conversation than the one on screen.
  //
  // So when an interruption finishes, the visible thread is re-read from disk and
  // normalized, exactly as hydration does it. Anything durable survives untouched --
  // including a partial answer that really was written before the Stop.
  const settledFrom = useRef(false);
  useEffect(() => {
    if (interrupting) {
      settledFrom.current = true;
      return;
    }
    if (!settledFrom.current) return;
    settledFrom.current = false;

    let cancelled = false;
    const owned = readVisibleRevision();
    void readThreadMessages(input.threadId).then((records) => {
      // A newer turn owns the list now; replacing it would drop its live reply. The
      // comparison is the revision, not `agent.isRunning`: the run is on a clone, so
      // the panel agent is idle even mid-answer, and a turn that has already SETTLED
      // still owns what it published.
      if (cancelled) return;
      publishVisibleIfOwned(agent, completeToolPairs(toTransportThread(records)), owned);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, interrupting, input.threadId]);

  // NO unmount cleanup of the active run handle, deliberately.
  //
  // A takeover or a scenario switch re-renders this panel into its read-only form in
  // the SAME synchronous update that notifies the interruption watch, so an unmount
  // that dropped the handle would win the race and leave the browser's stream running
  // with nothing to abort it. The handle is cleared by the run's own `finally` and by
  // the controller once it has aborted -- both of which outlive the component. Calling
  // `abortRun` on an unmounted agent is harmless: it aborts that run's fetch and
  // nothing else.

  // SINGLE FLIGHT over the whole prepare-to-settle window.
  //
  // `agent.isRunning` only covers the RUN, and preparation is the gap it cannot see.
  // Two submits landing in that gap would both claim a turn epoch -- and because
  // claiming one drops `authorizedTurnEpoch` (see the two-epoch note in the store),
  // the second claim would de-authorise the first turn's own tools the moment it
  // started preparing. Refusing before anything is claimed is what makes "at most one
  // run per panel" true rather than merely likely.
  const sending = useRef(false);
  // The same window, as render state: `isRunning` ends at settlement, a moment before
  // this flight does, and a send in that gap is refused as busy.
  const [sendInFlight, setSendInFlight] = useState(false);

  const runSend = useCallback(
    async (text: string) => {
      // Captured before anything can await: see `quarantine` for why a LAUNCH count,
      // and not the turn epoch, is what tells a revoked send from a superseded one.
      // Mutable: it moves to include THIS turn's own binding once it launches, so a
      // post-launch refusal is still published while a send superseded by a genuinely
      // newer turn is not.
      let launchBaseline = boundTurnGeneration();
      // Preparation is live work too: say so from the first moment, not the first byte.
      setTurnActivity(THINKING);

      // The first moment anything needs the runtime's launch identity, and therefore
      // the first moment this app makes the same-origin `/info` request. Cached, so a
      // second send costs nothing.
      await primeRuntimeInstanceId();

      const turnEpochForSend = assistantActions.nextTurnEpoch();
      const preparation = await prepareSend(
        {
          text,
          turnEpoch: turnEpochForSend,
          busy: agent.isRunning,
          interrupting: isInterrupting(),
        },
        {
          readSettings: () => readAssistantSettings(),
          readWriterContext: () => readWriterContext(),
          selectActiveThread: (scenarioId) => selectActiveThread(scenarioId),
          readThreadMessages: (threadId) => readThreadMessages(threadId),
          recordPreparingTurn: (turn) => recordPreparingTurn(turn),
          newRunId: () => crypto.randomUUID(),
          // The launch instance is stamped on every runtime response and reported by
          // `/info`; before the handshake resolves it is simply unknown, and an
          // unknown instance detaches rather than guessing.
          runtimeInstanceId: () => peekRuntimeInstanceId(),
        },
      );

      if (!preparation.ok) {
        assistantActions.abandonPreparing(turnEpochForSend);
        assistantActions.refuse(preparation.reason satisfies SendRefusal);
        return;
      }
      const { plan } = preparation;

      /**
       * Give up a prepared turn without contacting the provider.
       *
       * The turn row is a durable fact -- it was written before anything could run --
       * so it is SETTLED rather than forgotten, and settled as `revoked`: nothing was
       * ever sent, so calling it a detachment would overstate what is unknown. A turn
       * an interruption already settled keeps that interruption's terminal story;
       * relabelling it here would erase which trigger closed it.
       */
      const quarantine = async (reason: SendRefusal): Promise<void> => {
        // PUBLISH ONLY IF NO NEWER TURN HAS LAUNCHED.
        //
        // A refusal exists to tell a WAITING user why nothing was sent, so it is right
        // when their send is the one that was revoked. But preparation can be slow -- a
        // durable read, a blocked write -- and a send that resumes after the user
        // stopped and asked something else would paste its explanation on top of the
        // newer turn's answer. Its own durable row is settled below either way; only
        // the shared publication is conditional.
        //
        // No LAUNCH has happened since this send began. An interruption alone leaves
        // this unchanged -- so a user whose send was revoked while they waited still
        // gets told why -- while a send resuming after a newer turn has run and
        // answered stays silent.
        const noNewerLaunch = boundTurnGeneration() === launchBaseline;
        if (noNewerLaunch) {
          assistantActions.abandonPreparing(turnEpochForSend);
          assistantActions.refuse(reason);
        }
        // Atomic compare-and-set: an interruption that already settled this row keeps
        // its own terminal story rather than being relabelled `revoked`.
        await settleTurnIfUnsettled(plan.turn.turnId, "revoked");
      };

      /**
       * The live half of the launch check, sampled at the moment it is asked.
       *
       * The authority projection is read here rather than awaited from the repository
       * because being synchronous is the whole point: a same-tab commit publishes it
       * in the same task that lands the write, so a comparison against it cannot be
       * overtaken the way a durable reread can. Ownership is the projection's own
       * word, and a projection that disagrees with the persisted claim -- a commit
       * that could not be published, a hint still in flight -- fails the send closed.
       */
      const liveNow = (): LaunchLiveInput => {
        const authority = useAuthorityStore.getState();
        return {
          plan,
          boundThreadId: input.threadId,
          liveTurnEpoch: useAssistantStore.getState().turnEpoch,
          interrupting: isInterrupting(),
          busy: agent.isRunning,
          activeRunId: readActiveRunHandle()?.runId ?? null,
          live: {
            scenarioId: authority.scenarioId,
            documentRevision: authority.documentRevision,
            isOwner: authority.ownership === "owner",
          },
        };
      };

      // The thread the gate selected may not be the one this component is bound to
      // — the scenario can have changed under an open panel. Refuse rather than send
      // this document's question into the previous document's conversation; the
      // panel re-mounts on the new thread and the user can resend.
      if (plan.threadId !== input.threadId) {
        await quarantine("not_writer");
        return;
      }

      // Every write for this turn carries the generations the TURN captured, so a
      // Clear landing mid-answer fences the user message, every streamed message, and
      // every turn-state transition alike.
      const writeContext = {
        threadId: plan.threadId,
        scenarioId: plan.scenarioId,
        modelId: plan.modelId,
        turnId: plan.turn.turnId,
        globalGeneration: plan.globalGeneration,
        scenarioGeneration: plan.scenarioGeneration,
      };

      // Local first, so the user's own words survive a failed start -- and normalized
      // on this provider ingress too: `plan.history` is read straight from Dexie, so
      // this is the last point before a dangling call would be sent.
      publishVisible(agent, completeToolPairs(toTransportThread(plan.history)));
      const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: plan.text };
      agent.addMessage(userMessage);
      await persistThreadMessages([userMessage], {
        ...writeContext,
        createdAt: new Date().toISOString(),
      });

      // THE FINAL AUTHORIZATION. Everything above this line is preparation, and every
      // await in it is a window in which Stop, Disable, Remove key, Clear, a scenario
      // switch, a lease loss or a takeover could have closed this turn's authority.
      // A generation fence cannot help here: it drops later local writes, but it
      // cannot recall a request already sent to the provider.
      const authority = await authorizeLaunchAuthority(liveNow(), {
        readSettings: () => readAssistantSettings(),
        readWriterContext: () => readWriterContext(),
        readThread: (threadId) => readThread(threadId),
        readTurn: (turnId) => readTurn(turnId),
      });
      if (!authority.ok) {
        await quarantine(authority.reason);
        return;
      }

      // Marked streaming BEFORE the launch claim rather than after it, so the turn row
      // never says `preparing` while a run is live. Anything other than `accepted`
      // means a Clear moved the generation during preparation, and the conversation
      // this turn belongs to is already being deleted.
      if ((await setTurnState(plan.turn.turnId, { state: "streaming" })) !== "accepted") {
        await quarantine("cleared");
        return;
      }

      // SCRUBBED BEFORE THE CLAIM, and that ordering is the whole point.
      //
      // Publication filtering stops NEW damage, but a dangling row an older build or a
      // crash already wrote survives every sanitized upsert, so it has to be deleted
      // before anything hydrates from this thread. It used to sit just above the clone,
      // which read naturally and was wrong: it put an await AFTER the final identity
      // check, and a prepared turn suspended in it could resume past a Stop or a
      // takeover and overwrite the newer turn's handle, binding and lifecycle -- with
      // the hop guard stopping only the provider bytes, far too late to protect shared
      // state. Every await belongs above the claim; see the invariant below.
      await scrubThreadHistory(plan.threadId);

      // THE LAUNCH CLAIM, and the last `await` in the send.
      //
      // The authority reread above is separated from the provider by three more
      // awaits -- the thread read, the turn read and the streaming-state write -- and
      // an ordinary same-tab commit or a peer's lease advance needs no interruption,
      // moves no turn epoch and invalidates no turn row. Nothing before this point
      // would notice either, so the run would carry a document snapshot the schedule
      // has already moved past. Claimed here, and compared again below with no await
      // in between.
      const claim = await claimLaunchAuthority(plan, {
        readWriterContext: () => readWriterContext(),
      });
      if (!claim.ok) {
        await quarantine(claim.reason);
        return;
      }

      // NO `await` BETWEEN HERE AND `runAgent`, deliberately -- and that includes the
      // scrub, the history reads and every durable preparation step, all of which are
      // above the claim. The interruption controller closes the gate synchronously and
      // a commit publishes to the authority projection synchronously, so a check with
      // no microtask boundary after it cannot be overtaken by either -- which is the
      // only sense in which "atomic" is available to a browser turn.
      //
      // The segment this opens ends at `runAgent`, and it covers the handle
      // publication, `beginTurn` and `bindTurn`: every shared thing a revoked turn
      // could otherwise take from the turn that replaced it.
      const launch = authorizeLaunchIdentity({ ...liveNow(), claim: claim.writer });
      if (!launch.ok) {
        await quarantine(launch.reason);
        return;
      }

      // A DEDICATED AGENT INSTANCE FOR THIS TURN, and this is the isolation everything
      // below depends on.
      //
      // The panel's agent is long-lived and thread-scoped, so two overlapping turns --
      // a detached A whose tool is still suspended, and the B that replaced it -- would
      // otherwise share one message list, one subscriber list and one context scope.
      // A could then persist B's messages under A's write context, latch B's failure,
      // or serialise the shared list after B had changed it.
      //
      // `clone()` is public AG-UI, and CopilotKit's proxied agent implements it as a
      // complete copy: same runtime URL, headers, credentials, transport, thread and
      // message history, and crucially the SAME `agentId`, so the frontend tools
      // registered for this panel still attach. Tool execution, tool-result insertion
      // and bounded follow-ups remain CopilotKit's, driven through the public core
      // against this instance.
      const turnAgent = agent.clone() as typeof agent;
      // The clone inherits the panel agent's list, so normalize the provider's own
      // starting history too.
      turnAgent.setMessages(completeToolPairs(turnAgent.messages));

      // A DEDICATED CORE FOR THIS TURN TOO -- the clone alone is not enough.
      //
      // In locked 1.66.2 the run handler keeps ONE `_runDepth` and ONE
      // `_runAbortController` for the whole core. Only a depth-zero run creates the
      // controller; anything overlapping is treated as nested and reuses it, and the
      // follow-up branch is suppressed whenever that shared controller is aborted. So
      // with one core: Stop aborts A, A's non-cooperative handler keeps the top-level
      // promise alive, B starts as "nested", inherits the aborted controller, and
      // never gets its follow-up -- B could take a tool call but could never answer.
      //
      // The turn's own isolated runtime, built by the audited boundary. The session gets
      // run/errored/dispose and no core: holding one meant `setTools` could replace a
      // canonical handler here -- same name, same agent, same schema object -- while the
      // parent registry the mounted proof reads stayed untouched. Everything the inline
      // construction did (frozen tool snapshot, re-applied disables, transport, headers,
      // credentials, properties, debug, deferred handshake) happens there unchanged.
      const turnRunner = createTurnRunner();
      turnAgent.use(
        createProviderHopGuard(turnAgent, {
          // The approved snapshot rides each hop's run input -- see the guard for why
          // the agent-scoped context store cannot isolate two clones of one agent id.
          context: buildAssistantContext({
            scenario: plan.scenario,
            scenarioId: plan.scenarioId,
            documentRevision: plan.documentRevision,
            routePath: input.routePath,
            routeLabel: input.routeLabel,
          }),
        }),
      );

      // Published BEFORE the run so an interruption arriving in the same tick as the
      // first byte has something to abort -- and it aborts THIS turn's agent, not the
      // panel's. Cleared in `finally`, and by the controller itself when it aborts.
      setActiveRunHandle({
        threadId: plan.threadId,
        runId: plan.runId,
        abort: () => turnAgent.abortRun(),
      });
      assistantActions.beginTurn(plan.turn.turnId, turnEpochForSend);

      /**
       * Clean up after a resolve that arrived once this turn was no longer authorized.
       *
       * DELIBERATELY NOT `quarantine`. That one is for a PREPARED turn whose launch was
       * refused: nothing has happened yet, the user is waiting, and telling them why is
       * the whole point -- so it publishes a refusal and abandons the epoch. Neither is
       * true here. By the time a non-cooperative tool resolves, Stop has settled this
       * turn and a newer one may have answered; publishing A's refusal would paste a
       * stale explanation on top of B's successful reply, and touching the epoch or the
       * active turn would take state that is no longer A's to touch.
       *
       * So this makes NO shared publication at all. Its only effect is conditional: if
       * A's own durable row is somehow still unsettled, settle it; if an interruption
       * already did, this is a true no-op.
       */
      const settleOrphanedResolve = async (): Promise<void> => {
        // ONE atomic compare-and-set. A read followed by a write has a gap, and Stop's
        // truthful settlement lands in exactly that gap -- see `settleTurnIfUnsettled`.
        await settleTurnIfUnsettled(plan.turn.turnId, "revoked");
      };

      // WHAT MAY BECOME CANONICAL OR VISIBLE: complete tool call/result pairs only.
      // See `completeToolPairs` for why the boundary CopilotKit gives us is one event
      // too early, and why filtering the payload beats guarding the clock.
      const publishable = () => completeToolPairs(turnAgent.messages);

      // Persists THIS turn's agent, never the shared one. A detached turn writing the
      // panel agent's list would serialise whatever the newer turn had put there.
      //
      // SERIALISED, so two boundaries firing close together cannot interleave their
      // transactions and land an older snapshot after a newer one.
      let persistChain: Promise<void> = Promise.resolve();
      let persistFailureReported = false;
      /** Set by any rejected write. A turn whose history did not land is not complete. */
      let persistRejected = false;
      /** How many writes actually committed. Only read by tests, to prove non-vacuity. */
      let persistsCommitted = 0;
      const persist = () => {
        // THE PAYLOAD IS FROZEN AT THE AUTHORIZED MOMENT, not when the task runs.
        //
        // Reading the clone inside the queued closure was the defect: a task authorized
        // at `TOOL_CALL_END` can wait behind an in-flight write, and by the time it runs
        // the clone has moved on -- after a Stop, to a state nothing authorized. What is
        // captured here is a normalized snapshot of this instant, and it cannot change.
        // DEEP, not a copied array. The list belongs to the clone and CopilotKit keeps
        // growing the objects inside it -- content, tool-call arguments, result
        // payloads -- so a shallow copy would hand the queue live references and the
        // committed bytes would be whatever those had become by the time the write ran.
        const snapshot = freezeMessages(publishable());
        const createdAt = new Date().toISOString();

        persistChain = persistChain
          .then(async () => {
            // Two checks, and they answer different questions. This one is cheap and
            // skips a task whose turn died while it waited behind a slower write.
            if (!isTurnAuthorized(boundTurn.token)) return;
            // This one is the guarantee: evaluated INSIDE the write's own transaction,
            // so a Stop landing while the transaction is open still refuses the commit.
            // A check out here could not -- the write would already be underway.
            const outcome = await persistThreadMessages(
              snapshot,
              { ...writeContext, createdAt },
              {
                authorizeCommit: () => isTurnAuthorized(boundTurn.token),
                // The DURABLE half of the same question, compared inside the write's
                // own transaction so interruption's settlement and this write are
                // ordered by the store rather than by hope.
                requireUnsettledTurn: plan.turn.turnId,
              },
            );
            if (outcome === "accepted") persistsCommitted += 1;
          })
          .catch(() => {
            persistRejected = true;
            // RECOVERED, so one storage rejection cannot poison every later write and
            // the final snapshot. Reported once, without the error: a storage error can
            // carry request content, and the panel's message is the same either way.
            if (!persistFailureReported) {
              persistFailureReported = true;
              recordLifecycleEvent({
                trigger: null,
                phase: "settled",
                at: new Date(),
                errorClass: "persist_failed",
              });
            }
          });
        return persistChain;
      };

      /** Whether a callback's run genuinely belongs to this turn. */
      const ownsRun = (runId: string | undefined) =>
        runId !== undefined && boundTurn.ownedRunIds.has(runId);

      // The subscriber persists at each settled message boundary rather than per
      // chunk: a reload mid-answer then restores every complete message the user
      // already read, without writing to IndexedDB on every token.
      //
      // EVERY CALLBACK IS FILTERED ON THE PUBLIC `input.runId`. AG-UI invokes an
      // agent's subscribers for every run on that agent and supplies the concrete
      // input; a callback that ignored it would act on runs it does not own.
      //
      // THE RUN-FAILURE LATCH. `runAgent` does NOT reject when the agent run
      // fails: the locked core catches the error and resolves with an empty result, and
      // the documented public contract delivers failures through the error callbacks
      // instead. So a `catch` alone would mark a failed provider turn `completed` --
      // telling a nurse the assistant answered when the transport died.
      let runFailed = false;

      /**
       * Whether THIS turn produced new assistant text.
       *
       * A CONVERSATIONAL TURN SUCCEEDS BY REPLYING. A live turn once reached the
       * provider, came back with no message and no tool call, and settled `completed` --
       * so `lastSettlement` stayed null, the panel's notice rendered nothing, and the
       * user was left looking at their own question with no explanation. (The cause was
       * a tool schema the runtime could not convert; the silence was this branch.)
       *
       * A tool call is not a reply either: an initial call whose follow-up comes back
       * empty leaves the user equally unanswered, so only a completed assistant message
       * with visible content sets this -- see `onTextMessageEndEvent` below.
       * Anything the turn already produced -- a Preview card, a durable tool result --
       * keeps its own existing rules; this decides only what the turn is CALLED.
       *
       * Scoped to this turn's own runs by `ownsRun`, and to live events: prior assistant
       * history is never re-emitted, so an empty new turn cannot look productive because
       * the conversation above it has answers in it.
       */
      let producedAssistantText = false;
      const subscriber: AgentSubscriber = {
        onEvent: ({ event, input: runInput }) => {
          if (!ownsRun(runInput?.runId)) return;
          if (event.type !== "TEXT_MESSAGE_END" && event.type !== "TOOL_CALL_END") return;
          // BOTH GATES, and owning the run is the weaker one.
          //
          // Run ownership answers "is this event mine?"; it does not answer "may I
          // still write?". Stop, Disable and a takeover all PRESERVE the history
          // generations, so unlike Clear their late events would be accepted durably --
          // a stopped turn would go on appending its own tool calls and answers to the
          // conversation. The token is what makes the write conditional on the turn
          // still being live, and it guards the durable write and the visible mirror
          // alike: a half-written tool call is exactly what a later turn would then
          // hydrate into its provider history.
          if (!isTurnAuthorized(boundTurn.token)) return;
          void persist();
          // The panel renders the shared agent, so a turn running on its own clone has
          // to publish what the user should see -- and it sees the same complete-pair
          // view the durable history gets, never a dangling call.
          publishVisible(agent, publishable());
        },
        // THE REPLY TEST, and it has to read the BUFFER rather than the boundary.
        //
        // AG-UI accepts `TEXT_MESSAGE_START` -> `TEXT_MESSAGE_END` with nothing between
        // them, so a boundary alone proves only that the model opened and closed a
        // message. Latching on the event let a direct empty message -- and a tool whose
        // follow-up came back empty -- settle `completed` again, with no reply on screen
        // and no notice: the same silence, one layer down.
        //
        // `textMessageBuffer` is the locked public contract's own view of what that
        // message finally contained, handed to this callback by `defaultApplyEvents`. It
        // is the completed buffer for THIS event, not a running one, so no partial
        // stream can satisfy it and nothing is inferred from history, another run, a
        // tool call/result or a Preview card.
        onTextMessageEndEvent: ({ input: runInput, textMessageBuffer }) => {
          if (!ownsRun(runInput?.runId)) return;
          // Whitespace is not an answer a nurse can read.
          if (textMessageBuffer.trim().length === 0) return;
          producedAssistantText = true;
        },
        onRunFailed: ({ input: runInput }) => {
          if (!ownsRun(runInput?.runId)) return;
          runFailed = true;
        },
        // THE LIVE MIRROR. The boundary publish above is what gets PERSISTED; this is
        // only what the user SEES while the clone streams, so a reply appears token by
        // token instead of in one block at `TEXT_MESSAGE_END`. `onMessagesChanged`
        // rather than `onEvent` because AG-UI runs `onEvent` before it applies the
        // delta. Same two gates, same complete-pair view -- never a dangling call, and
        // nothing after this turn lost authority. Nothing here touches disk: a Stop
        // mid-stream still reconciles the panel from durable history.
        onMessagesChanged: ({ input: runInput, messages }) => {
          if (!ownsRun(runInput?.runId)) return;
          if (!isTurnAuthorized(boundTurn.token)) return;
          publishVisible(agent, publishable());
          setTurnActivity(describeTurnActivity(messages));
        },
      };

      // THE BOUND TURN. From here until `finally`, this is the turn every provider
      // hop and every tool handler is checked against -- see `./turn-authority`. It
      // carries the launch claim so a tool can compare the LEASE EPOCH without opening
      // its own transaction; the hop guard refreshes it on each hop.
      const boundTurn: BoundTurn = {
        token: {
          agent: turnAgent,
          threadId: plan.threadId,
          scenarioId: plan.scenarioId,
          turnId: plan.turn.turnId,
          runId: plan.runId,
          turnEpoch: turnEpochForSend,
        },
        plan,
        boundThreadId: input.threadId,
        liveNow,
        claim: claim.writer,
        // The top-level run; the hop guard adds each follow-up as it authorises it.
        ownedRunIds: new Set([plan.runId]),
        refusal: null,
      };

      // Subscribed to THIS TURN'S agent, so the initial hop and every follow-up publish
      // their boundaries through the same generation-fenced persistence -- and no other
      // turn's do. A per-run subscriber would have covered the first hop and silently
      // dropped the answer the follow-up produced.
      const subscription = turnAgent.subscribe(subscriber);
      bindTurn(boundTurn);
      // This turn's own launch is now part of the baseline -- see `quarantine`.
      launchBaseline = boundTurnGeneration();

      try {
        // CopilotKit's own run entry point: it attaches the registered frontend tools,
        // executes their handlers, inserts the tool-result messages, yields to the
        // framework between steps, and drives bounded follow-up runs. Reimplementing
        // any of that here is what produced a turn that called a tool and then stopped.
        await turnRunner.run({ agent: turnAgent, runId: plan.runId });

        // THE FINAL SNAPSHOT IS QUEUED AND DRAINED HERE, before any settlement clears
        // authority. Leaving it to `finally` meant `endTurn` had already dropped the
        // authorized epoch, so the last write was skipped and a completed pair with no
        // later text boundary was simply lost.
        if (isTurnAuthorized(boundTurn.token)) await persist();

        // SETTLEMENT PRECEDENCE, in this order and for a reason:
        //   0. no live authority -- settle this turn's own row and publish NOTHING;
        //   1. an authority refusal -- the truest cause, and never a transport story;
        //   2. a latched run or persistence failure -- it resolved, but did not succeed;
        //   3. completion, claimed only when none of the above happened.
        //
        // AUTHORITY IS CHECKED BEFORE THE REFUSAL, and the order is the point.
        //
        // `quarantine` publishes a shared refusal so a WAITING user learns why nothing
        // was sent. That is right while this turn is still the live one. It is wrong
        // once it is not: a hop-guard refusal recorded during Stop would otherwise be
        // published after a newer turn had already answered, pasting a stale
        // explanation over B's reply. The same defect the unauthorized-resolve path
        // had, living in a second branch.
        if (boundTurn.refusal) {
          // `quarantine` decides for itself whether a shared publication is still
          // appropriate -- a refusal the waiting user needs, versus one that would land
          // on a newer turn's answer.
          await quarantine(boundTurn.refusal);
        } else if (!isTurnAuthorized(boundTurn.token)) {
          await settleOrphanedResolve();
        } else if (runFailed || turnRunner.errored() || persistRejected || !producedAssistantText) {
          // A turn whose conversation could not be written is not one that completed:
          // claiming success would tell the user their answer was kept when a reload
          // will show it missing.
          // The agent latch covers a failed RUN; the core subscriber covers the errors
          // the core reports around it. Either makes "completed" untrue.
          //
          // AND NEITHER DOES A RUN THAT SAID NOTHING. `run_failed` is reused rather than
          // given a sibling: its wording is already exactly right ("That reply could not
          // be completed. … Send again to retry."), and its meaning was always "the run
          // failed to produce a reply" rather than "a socket died" -- so this needs no
          // new durable value and no migration for older rows to carry.
          await setTurnState(plan.turn.turnId, { state: "detached", settlement: "run_failed" });
          assistantActions.endTurn("run_failed", plan.turn.turnId);
        } else {
          await setTurnState(plan.turn.turnId, { state: "terminal", settlement: "completed" });
          assistantActions.endTurn("completed", plan.turn.turnId);
        }
      } catch {
        // The failure detail is deliberately dropped: a provider or transport error
        // object may carry request content, and the panel's message is the same in
        // every case — nothing was changed, and the user may retry.
        //
        // An abort raised by an interruption lands here too, and that is harmless: the
        // controller owns this turn's terminal state and its own write comes after,
        // while a fenced write here is dropped rather than applied.
        // Same ordering as the resolve path, for the same reason.
        if (boundTurn.refusal) {
          await quarantine(boundTurn.refusal);
        } else if (!isTurnAuthorized(boundTurn.token)) {
          await settleOrphanedResolve();
        } else {
          await setTurnState(plan.turn.turnId, { state: "detached", settlement: "run_failed" });
          assistantActions.endTurn("run_failed", plan.turn.turnId);
        }
      } finally {
        // EVERY TEARDOWN HERE IS COMPARE-AND-CLEAR, because this block can run LATE --
        // after an interruption detached this turn and a newer one took over. An
        // unconditional cleanup would then remove the NEWER turn's Stop target, its
        // running state and its authority, from a turn that no longer exists.
        //
        // Unbound first: nothing after this point may still speak for the turn, and a
        // late tool callback whose token no longer matches refuses by construction.
        // Whether this turn may still write, sampled before the release below changes
        // the answer.
        //
        // LIVE AUTHORITY, not binding identity. "The module still points at me" only
        // says no newer turn has replaced me -- which is true of a turn the user
        // stopped seconds ago while nothing else started. Persisting then would write
        // the superseded tool result CopilotKit inserted after the Stop, and leave it
        // for the next turn to hydrate.
        const mayPersist = isTurnAuthorized(boundTurn.token);
        releaseTurn(boundTurn);
        subscription.unsubscribe();
        turnRunner.dispose();
        // No context to remove: it rode this turn's run inputs and died with them.
        clearActiveRunHandle(plan.runId);
        // Whatever is still queued must finish before this turn is done, but nothing
        // NEW is enqueued here: the authorized final snapshot was taken above, while
        // authority still existed. Draining a recovered chain cannot reject.
        if (mayPersist) await persistChain;
      }
    },
    [agent, agentId, createTurnRunner, input.threadId, input.routePath, input.routeLabel],
  );

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (input.historical) {
        assistantActions.refuse("not_writer");
        return false;
      }
      if (sending.current) {
        assistantActions.refuse("busy");
        return false;
      }
      sending.current = true;
      setSendInFlight(true);
      try {
        await runSend(text);
        return true;
      } finally {
        sending.current = false;
        setSendInFlight(false);
      }
    },
    [input.historical, runSend],
  );

  // Stop is the interruption controller and nothing else. T04's inline
  // epoch-bump-plus-abort is deliberately gone: a second partial cancellation path is
  // exactly what the tech plan forbids, and this one also stops the SERVER-side run,
  // cancels owned diagnostic jobs, and settles or detaches within 15 seconds.
  const stop = useCallback(() => {
    void assistantActions.interrupt({
      trigger: "stop",
      threadId: input.threadId,
      scenarioId: useAuthorityStore.getState().scenarioId,
    });
  }, [input.threadId]);

  return {
    messages: agent.messages,
    // FROM THE TURN, NOT THE PANEL AGENT. Every turn runs on its own clone, so the
    // long-lived panel agent is idle for the whole run -- and this value is what the
    // locked `CopilotChatView` uses to decide whether to render Stop at all. Read from
    // it, a live turn would offer the user Send instead of Stop. The store subscription
    // is also what makes this REACTIVE: it re-renders on start, settle, Stop, takeover,
    // Disable, Clear, failure and completion alike, because each of those moves the
    // same two lifecycle fields.
    isRunning: liveTurn,
    // An interruption has its own truthful line (`LifecycleNotice`); "Thinking…" beside
    // "Stopping…" would contradict it.
    activity: liveTurn && !interrupting ? turnActivity : null,
    connecting: !isReady,
    interrupting,
    sending: sendInFlight,
    send,
    stop,
  };
}
