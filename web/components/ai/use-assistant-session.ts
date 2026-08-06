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

import { useCallback, useEffect, useRef } from "react";
import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import type { AgentSubscriber, Message } from "@ag-ui/client";
import { AI_AGENT_ID } from "@/lib/ai/protocol";
import {
  UNSETTLED_TURN_STATES,
  persistThreadMessages,
  readThread,
  readThreadMessages,
  readTurn,
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
} from "@/lib/ai/assistant/history-repo";
import { toTransportThread } from "@/lib/ai/assistant/messages";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";
import { buildAssistantContext } from "@/lib/ai/assistant/scenario-context";
import {
  authorizeLaunchAuthority,
  authorizeLaunchIdentity,
  prepareSend,
  type LaunchIdentityInput,
  type SendRefusal,
} from "@/lib/ai/assistant/send-gate";
import {
  peekRuntimeInstanceId,
  primeRuntimeInstanceId,
  readActiveRunHandle,
  setActiveRunHandle,
} from "@/lib/ai/assistant/runtime-stop";
import { assistantActions, isInterrupting, useAssistantStore } from "@/lib/ai/assistant/store";
import { readWriterContext } from "@/lib/ai/assistant/writer-context";
import { useAuthorityStore } from "@/lib/store";
import { useContextTools } from "./use-context-tools";

/** The local registry id for this thread's private proxied agent. */
export function localAgentId(threadId: string): string {
  return `${AI_AGENT_ID}:${threadId}`;
}

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

export interface AssistantSession {
  messages: Message[];
  isRunning: boolean;
  /** True until the agent instance is the real runtime-synced one. */
  connecting: boolean;
  /** True while an interruption has closed the gate and has not settled. */
  interrupting: boolean;
  send(text: string): Promise<void>;
  stop(): void;
}

export function useAssistantSession(input: AssistantSessionInput): AssistantSession {
  const agentId = localAgentId(input.threadId);
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
  useContextTools(agentId, authorizedTurnEpoch ?? -1);

  const interrupting = useAssistantStore((state) => state.interruption !== null);

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
    void readThreadMessages(input.threadId).then((records) => {
      // A run that started while the read was in flight owns the message list now;
      // replacing it would drop the streaming reply.
      if (cancelled || agent.isRunning) return;
      agent.setMessages(toTransportThread(records));
    });
    return () => {
      cancelled = true;
    };
  }, [agent, isReady, input.threadId]);

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

  const runSend = useCallback(
    async (text: string) => {
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
        assistantActions.abandonPreparing(turnEpochForSend);
        assistantActions.refuse(reason);
        const current = await readTurn(plan.turn.turnId);
        if (!current || !UNSETTLED_TURN_STATES.includes(current.state)) return;
        await setTurnState(plan.turn.turnId, { state: "terminal", settlement: "revoked" });
      };

      /** The live half of the launch check, sampled at the moment it is asked. */
      const identityNow = (): LaunchIdentityInput => ({
        plan,
        boundThreadId: input.threadId,
        liveTurnEpoch: useAssistantStore.getState().turnEpoch,
        interrupting: isInterrupting(),
        busy: agent.isRunning,
        activeRunId: readActiveRunHandle()?.runId ?? null,
      });

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

      // Local first, so the user's own words survive a failed start.
      agent.setMessages(toTransportThread(plan.history));
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
      const authority = await authorizeLaunchAuthority(identityNow(), {
        readSettings: () => readAssistantSettings(),
        readWriterContext: () => readWriterContext(),
        readThread: (threadId) => readThread(threadId),
        readTurn: (turnId) => readTurn(turnId),
      });
      if (!authority.ok) {
        await quarantine(authority.reason);
        return;
      }

      // Marked streaming BEFORE the last check rather than after it, so this fenced
      // durable write is the last `await` in the send. Anything other than `accepted`
      // means a Clear moved the generation during preparation, and the conversation
      // this turn belongs to is already being deleted.
      if ((await setTurnState(plan.turn.turnId, { state: "streaming" })) !== "accepted") {
        await quarantine("cleared");
        return;
      }

      // NO `await` BETWEEN HERE AND `runAgent`, deliberately. The interruption
      // controller closes the gate synchronously, so a check with no microtask
      // boundary after it cannot be overtaken by a closure that has already been
      // requested -- which is the only sense in which "atomic" is available to a
      // browser turn.
      const launch = authorizeLaunchIdentity(identityNow());
      if (!launch.ok) {
        await quarantine(launch.reason);
        return;
      }

      // Published BEFORE the run so an interruption arriving in the same tick as the
      // first byte has something to abort. Cleared in `finally`, and by the controller
      // itself when it aborts -- whichever happens first.
      setActiveRunHandle({
        threadId: plan.threadId,
        runId: plan.runId,
        abort: () => agent.abortRun(),
      });
      assistantActions.beginTurn(plan.turn.turnId, turnEpochForSend);

      const persist = () =>
        persistThreadMessages(agent.messages, {
          ...writeContext,
          createdAt: new Date().toISOString(),
        });

      // Persisted at each settled message boundary rather than per chunk: a reload
      // mid-answer then restores every complete message the user already read,
      // without writing to IndexedDB on every token.
      const subscriber: AgentSubscriber = {
        onEvent: ({ event }) => {
          if (event.type === "TEXT_MESSAGE_END" || event.type === "TOOL_CALL_END") void persist();
        },
      };

      try {
        await agent.runAgent(
          {
            runId: plan.runId,
            context: buildAssistantContext({
              scenario: plan.scenario,
              scenarioId: plan.scenarioId,
              documentRevision: plan.documentRevision,
              routePath: input.routePath,
              routeLabel: input.routeLabel,
            }),
          },
          subscriber,
        );
        await setTurnState(plan.turn.turnId, { state: "terminal", settlement: "completed" });
        assistantActions.endTurn("completed");
      } catch {
        // The failure detail is deliberately dropped: a provider or transport error
        // object may carry request content, and the panel's message is the same in
        // every case — nothing was changed, and the user may retry.
        //
        // An abort raised by an interruption lands here too, and that is harmless: the
        // controller owns this turn's terminal state and its own write comes after,
        // while a fenced write here is dropped rather than applied.
        await setTurnState(plan.turn.turnId, { state: "detached", settlement: "run_failed" });
        assistantActions.endTurn("run_failed");
      } finally {
        setActiveRunHandle(null);
        await persist();
      }
    },
    [agent, input.threadId, input.routePath, input.routeLabel],
  );

  const send = useCallback(
    async (text: string) => {
      if (input.historical) {
        assistantActions.refuse("not_writer");
        return;
      }
      if (sending.current) {
        assistantActions.refuse("busy");
        return;
      }
      sending.current = true;
      try {
        await runSend(text);
      } finally {
        sending.current = false;
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
    isRunning: agent.isRunning,
    connecting: !isReady,
    interrupting,
    send,
    stop,
  };
}
