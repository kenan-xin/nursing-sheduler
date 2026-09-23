"use client";

// The assistant's e2e driving seam (T11).
//
// WHY A SECOND BRIDGE RATHER THAN MORE OF `shell/test-bridge.tsx`. The assistant is
// a LEAF: `lib/ai/independence.test.ts` enforces at the source level that nothing
// outside `lib/ai/`, `components/ai/`, `components/settings/` and a handful of
// listed mount points may reference assistant modules, so a broken or disabled
// assistant cannot break scheduling. Widening that allowlist so a shell-owned test
// file could import the assistant repositories would spend a real architectural
// boundary on test convenience. This file lives inside an OWNER directory instead,
// and `app-shell.tsx` -- already a permitted mount point -- renders it.
//
// WHAT IT EXPOSES, on the same terms as the scenario bridge: the REAL durable
// functions the product itself calls. No setter, no state injection. In particular
// `appendMessage` goes through `persistThreadMessages`, so a spec driving it
// exercises the genuine generation fence -- the only way to prove the Clear ->
// detach -> reload -> late-callback quarantine against real IndexedDB across two
// real page lifetimes rather than against `fake-indexeddb` inside one process.
//
// COMPILED OUT OF ORDINARY PRODUCTION, exactly like the scenario bridge: the guard
// is a build-time constant, so a plain `pnpm build` inlines `false` and tree-shakes
// every import below away. The e2e harness sets `NEXT_PUBLIC_NS_TEST_BRIDGE=1` for
// its own build and still opts in per page via `addInitScript`.

import { useEffect } from "react";
import type { Message } from "@ag-ui/client";

import { getAssistantDb } from "@/lib/ai/assistant/db";
import {
  persistThreadMessages,
  readThread,
  selectActiveThread,
  threadGenerations,
  type WriteOutcome,
} from "@/lib/ai/assistant/history-repo";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";
import type { AssistantGenerationPair } from "@/lib/ai/assistant/fence";
import type { AssistantSettingsV1 } from "@/lib/ai/assistant/records";
import { readClearFacts } from "@/lib/ai/assistant/clear-repo";
import {
  assistantActions,
  selectReady,
  useAssistantStore,
  type ClearActionResult,
} from "@/lib/ai/assistant/store";

/** One conversion, so every bridge path reports the same fields the same way. */
function toBridgeFacts(result: ClearActionResult): BridgeClearFacts {
  return {
    requestId: result.requestId,
    operationId: result.operationId,
    status: result.status,
    scope: result.scope,
    scenarioId: result.scenarioId,
    reason: result.reason,
    settlement: result.settlement,
    deletionOutcome: result.deletionOutcome,
    configurationOutcome: result.configurationOutcome,
  };
}

/** Every table the assistant owns. A clear must leave all of them empty. */
/**
 * The assistant-owned content tables the bridge counts.
 *
 * Exported so the drift test can hold this, the Clear scope and the contract to the
 * same definition -- the browser Clear journey asserts these counts, and a table
 * missing here is a table the journey silently stops checking.
 */
export const ASSISTANT_TABLES = [
  "assistantSettings",
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
  "assistantProposals",
  "assistantReceipts",
  "diagnosticSearches",
  // Bookkeeping, not content -- but Clear all must leave none of it behind either.
  "assistantClearOperations",
] as const;

export interface AssistantBridge {
  /** The durable settings row, exactly as stored. Off-by-default is a fact here. */
  settings(): Promise<AssistantSettingsV1>;
  /** The live readiness projection every assistant surface gates on. */
  ready(): boolean;
  /** The most recent turn row, so a browser journey can read how it settled. */
  lastTurn(): Promise<{
    turnId: string;
    state: string;
    terminalReason: string | null;
  } | null>;
  /** Whether a diagnostic card is currently published. */
  activeDiagnostic(): boolean;
  /** Ordinary Optimize rows, which assistant Clear must leave alone. */
  optimizeBases(): Promise<number>;
  /** Row counts per assistant table, plus the surviving fence rows. */
  tableCounts(): Promise<Record<string, number>>;
  /** Select (or create) this scenario's active thread through the product path. */
  selectThread(scenarioId: string): Promise<{ threadId: string } & AssistantGenerationPair>;
  /**
   * Append one message through the REAL fenced write.
   *
   * `generations` is what makes this a late-callback driver: pass a pair captured
   * BEFORE a clear and the write must be dropped, not merely fail.
   *
   * `role` defaults to `user` -- the fence journeys only ever needed one side of a
   * conversation. The chat-UI journey needs BOTH sides, because "user and assistant
   * messages have distinct readable layout" is not a claim a thread of user turns
   * could be made to fail. It is passed straight through to the same fenced write, so
   * a seeded assistant turn is persisted, hydrated and rendered by the shipped path
   * rather than injected into the view.
   */
  appendMessage(input: {
    threadId: string;
    scenarioId: string;
    messageId: string;
    content: string;
    role?: "user" | "assistant";
    generations?: AssistantGenerationPair;
  }): Promise<WriteOutcome>;
  /** The generations a live caller would stamp on a write for this thread. */
  threadGenerations(threadId: string): Promise<AssistantGenerationPair | null>;
  /** Clear every local AI setting, credential and conversation. */
  clearAll(scenarioId: string | null): Promise<BridgeClearFacts>;
  /** Clear one scenario's conversation, optionally as a retry of a known operation. */
  clearHistory(scenarioId: string, retryOfOperationId?: string | null): Promise<BridgeClearFacts>;
  /**
   * The durable terminal records, as the strict parser reads them.
   *
   * Exposed so a browser journey can compare what a call RETURNED against what is on
   * disk, field by field. Without it a spec can only check the return value against
   * itself, which is exactly the correlation the round-15 review found missing.
   */
  clearFacts(): Promise<BridgeClearFacts[]>;
}

/**
 * The canonical Clear facts, flattened for `page.evaluate` transport.
 *
 * Deliberately the SAME field names as `ClearFacts` and as the durable record, so a
 * spec compares like with like instead of translating between three vocabularies.
 */
export interface BridgeClearFacts {
  requestId: string;
  operationId: string;
  status: "deleted" | "incomplete" | "failed";
  scope: "history" | "all";
  scenarioId: string | null;
  reason: string | null;
  settlement: string | null;
  deletionOutcome: string | null;
  /** What this invocation proved about the stored configuration. */
  configurationOutcome: "deleted" | "retained" | "unknown";
}

declare global {
  interface Window {
    __nsAssistant?: AssistantBridge;
  }
}

const BRIDGE_COMPILED_IN =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_NS_TEST_BRIDGE === "1";

export function AssistantTestBridge() {
  useEffect(() => {
    if (!BRIDGE_COMPILED_IN) return;
    const enabled =
      process.env.NODE_ENV !== "production" || window.__NS_ENABLE_TEST_BRIDGE === true;
    if (!enabled) return;

    window.__nsAssistant = {
      settings: () => readAssistantSettings(),
      ready: () => selectReady(useAssistantStore.getState()),
      async tableCounts() {
        const db = getAssistantDb();
        const entries = await Promise.all(
          [...ASSISTANT_TABLES, "assistantGenerations"].map(
            async (name) => [name, await db.table(name).count()] as const,
          ),
        );
        return Object.fromEntries(entries);
      },
      async selectThread(scenarioId) {
        const thread = await selectActiveThread(scenarioId);
        return { threadId: thread.threadId, ...threadGenerations(thread) };
      },
      async appendMessage(input) {
        const thread = input.generations ? null : await readThread(input.threadId);
        // No explicit pair and no thread means nothing to stamp from. Generation 0 is
        // the honest stand-in: any clear has bumped past it, so the write is fenced --
        // the correct answer for a callback whose thread is already gone.
        const stamped: AssistantGenerationPair =
          input.generations ??
          (thread ? threadGenerations(thread) : { globalGeneration: 0, scenarioGeneration: 0 });
        const message: Message = {
          id: input.messageId,
          role: input.role ?? "user",
          content: input.content,
        };
        return persistThreadMessages([message], {
          threadId: input.threadId,
          scenarioId: input.scenarioId,
          modelId: null,
          turnId: null,
          createdAt: new Date().toISOString(),
          ...stamped,
        });
      },
      async threadGenerations(threadId) {
        const thread = await readThread(threadId);
        return thread ? threadGenerations(thread) : null;
      },
      /** The most recent turn row, so a browser journey can read how it settled. */
      async lastTurn() {
        const turns = await getAssistantDb().assistantTurns.toArray();
        const latest = turns
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .at(-1);
        return latest
          ? { turnId: latest.turnId, state: latest.state, terminalReason: latest.terminalReason }
          : null;
      },
      /** The in-memory diagnostic card. Clear must leave none behind. */
      activeDiagnostic() {
        return useAssistantStore.getState().activeDiagnostic !== null;
      },
      /** Ordinary Optimize evidence, which assistant Clear must NOT touch. */
      optimizeBases() {
        return getAssistantDb().table("optimizeBases").count();
      },
      // SERIALIZED FROM THE AWAITED RETURN VALUE, never re-read from the store. The
      // store holds the LATEST clear's projection, so a queued or repeated call that
      // read it back would report its successor's outcome as its own.
      async clearAll(scenarioId) {
        return toBridgeFacts(await assistantActions.clearAll({ threadId: null, scenarioId }));
      },
      async clearHistory(scenarioId, retryOfOperationId) {
        return toBridgeFacts(
          await assistantActions.clearHistory(
            { threadId: null, scenarioId },
            { retryOfOperationId: retryOfOperationId ?? null },
          ),
        );
      },
      async clearFacts() {
        return (await readClearFacts()).map((row) => ({
          requestId: row.requestId,
          operationId: row.operationId,
          status: row.status,
          scope: row.scope,
          scenarioId: row.scenarioId,
          reason: row.reason,
          settlement: row.settlement,
          deletionOutcome: row.deletionOutcome,
          configurationOutcome: row.configurationOutcome,
        }));
      },
    };

    return () => {
      delete window.__nsAssistant;
    };
  }, []);

  return null;
}
