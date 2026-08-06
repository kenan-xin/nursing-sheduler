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
  persistThreadMessages,
  readThreadMessages,
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
} from "@/lib/ai/assistant/history-repo";
import { toTransportThread } from "@/lib/ai/assistant/messages";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";
import { buildAssistantContext } from "@/lib/ai/assistant/scenario-context";
import { prepareSend, type SendRefusal } from "@/lib/ai/assistant/send-gate";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { readWriterContext } from "@/lib/ai/assistant/writer-context";
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

  const turnEpoch = useAssistantStore((state) => state.turnEpoch);
  useContextTools(agentId, turnEpoch);

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

  const send = useCallback(
    async (text: string) => {
      if (input.historical) {
        assistantActions.refuse("not_writer");
        return;
      }

      const turnEpochForSend = assistantActions.nextTurnEpoch();
      const preparation = await prepareSend(
        { text, turnEpoch: turnEpochForSend, busy: agent.isRunning },
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
          runtimeInstanceId: () => null,
        },
      );

      if (!preparation.ok) {
        assistantActions.refuse(preparation.reason satisfies SendRefusal);
        return;
      }
      const { plan } = preparation;

      // The thread the gate selected may not be the one this component is bound to
      // — the scenario can have changed under an open panel. Refuse rather than send
      // this document's question into the previous document's conversation; the
      // panel re-mounts on the new thread and the user can resend.
      if (plan.threadId !== input.threadId) {
        assistantActions.refuse("not_writer");
        return;
      }

      // Local first, so the user's own words survive a failed start.
      agent.setMessages(toTransportThread(plan.history));
      const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: plan.text };
      agent.addMessage(userMessage);
      await persistThreadMessages([userMessage], {
        threadId: plan.threadId,
        scenarioId: plan.scenarioId,
        modelId: plan.modelId,
        turnId: plan.turn.turnId,
        createdAt: new Date().toISOString(),
      });

      assistantActions.beginTurn(plan.turn.turnId);
      await setTurnState(plan.turn.turnId, "streaming");

      const persist = () =>
        persistThreadMessages(agent.messages, {
          threadId: plan.threadId,
          scenarioId: plan.scenarioId,
          modelId: plan.modelId,
          turnId: plan.turn.turnId,
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
        await setTurnState(plan.turn.turnId, "terminal", "completed");
        assistantActions.endTurn();
      } catch {
        // The failure detail is deliberately dropped: a provider or transport error
        // object may carry request content, and the panel's message is the same in
        // every case — nothing was changed, and the user may retry.
        await setTurnState(plan.turn.turnId, "detached", "run_failed");
        assistantActions.endTurn("run_failed");
      } finally {
        await persist();
      }
    },
    [agent, input.historical, input.threadId, input.routePath, input.routeLabel],
  );

  const stop = useCallback(() => {
    const activeTurnId = useAssistantStore.getState().activeTurnId;
    // Bumping the epoch is what closes the LOCAL gate: any tool handler still
    // running sees a changed epoch and returns nothing to the model. The abort then
    // stops the stream. T05 owns the full settlement contract around this.
    assistantActions.nextTurnEpoch();
    agent.abortRun();
    if (activeTurnId) void setTurnState(activeTurnId, "terminal", "stopped");
    assistantActions.endTurn();
  }, [agent]);

  return {
    messages: agent.messages,
    isRunning: agent.isRunning,
    connecting: !isReady,
    send,
    stop,
  };
}
