// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { z } from "zod";

// THE SESSION'S PERSISTENCE QUEUE, through the shipped path.
//
// The repository suite proves the commit boundary in isolation. What it cannot prove
// is the WIRING: that the session enqueues an immutable snapshot, skips a task whose
// turn died while it waited, recovers from a rejection without poisoning the writes
// after it, and drains its final snapshot before authority is released. Those are
// properties of the hook, so they are tested through the hook -- real core, real
// agent, real store, real Dexie -- with a barrier around the repository boundary and
// counters proving each intended write actually entered, rejected or resumed.

const repo = vi.hoisted(() => {
  const state = {
    /** Resolves when a blocked write may proceed. */
    gate: null as null | (() => void),
    /** Number of writes that have ENTERED the repository. */
    entered: 0,
    /** Which entry numbers to block (1-based). */
    blockOn: new Set<number>(),
    /** Which entry numbers to reject (1-based). */
    rejectOn: new Set<number>(),
    /**
     * Reject by CONTENT rather than by position.
     *
     * The final write's entry number is a property of the transport shape, so naming it
     * as a literal would silently stop testing the final write the day a boundary is
     * added. The predicate identifies it by what it carries instead, and the test then
     * asserts nothing entered after it.
     */
    rejectWhen: null as
      | null
      | ((messages: readonly { role?: string; content?: unknown }[]) => boolean),
    /** Entry numbers that actually rejected. */
    rejected: [] as number[],
    /** Entry numbers that actually committed. */
    committed: [] as number[],
    /** Payload sizes as committed, so a late mutation would be visible. */
    committedSizes: [] as number[],
    waiting: null as null | (() => void),
    /**
     * Suspends the write INSIDE the real repository transaction, after a true guard.
     *
     * The `blockOn` barrier above stops a write before it enters the repository, which
     * is the queue's window, not the transaction's. This one is forwarded into the real
     * `persistThreadMessages` as its `barrier` config, so it suspends between the
     * thread read, the turn read, the history read, each put and the callback return --
     * every point at which authority was just checked and found good.
     */
    barrier: null as null | ((point: string) => Promise<void> | void),
    /** The entry number currently inside the repository. Read by a barrier. */
    currentNth: 0,
    /**
     * Whether the payload currently inside the repository carries anything the model
     * produced.
     *
     * Barriers select on this, and they must. The first turn-owned write happens at
     * `TOOL_CALL_END`, when no result exists yet -- so `completeToolPairs` strips the
     * incomplete pair and the payload is the user's prompt alone. Suspending THAT write
     * and revoking authority proves nothing: there is nothing in it to leak, and the
     * case passes with every commit-boundary check removed. The write that can actually
     * leak is a later one, whose snapshot carries the assistant and tool messages.
     */
    currentHasAssistant: false,
    /** An ordered log of repository completions and externally observed settlements. */
    events: [] as string[],
  };
  return state;
});

vi.mock("@/lib/ai/assistant/history-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/assistant/history-repo")>();
  return {
    ...actual,
    persistThreadMessages: async (
      messages: Parameters<typeof actual.persistThreadMessages>[0],
      context: Parameters<typeof actual.persistThreadMessages>[1],
      config?: Parameters<typeof actual.persistThreadMessages>[2],
    ) => {
      const nth = (repo.entered += 1);
      repo.waiting?.();
      if (repo.blockOn.has(nth)) {
        await new Promise<void>((resolve) => {
          repo.gate = resolve;
        });
      }
      if (repo.rejectOn.has(nth) || repo.rejectWhen?.(messages)) {
        repo.rejected.push(nth);
        throw new Error("storage rejected");
      }
      repo.currentNth = nth;
      repo.currentHasAssistant = messages.some((message) => message.role !== "user");
      const outcome = await actual.persistThreadMessages(messages, context, {
        ...config,
        // Only turn-owned writes: the send's own direct write of the user's prompt
        // carries no `requireUnsettledTurn`, and suspending THAT would test the loss of
        // the one row every case below asserts survives.
        ...(repo.barrier && config?.requireUnsettledTurn ? { barrier: repo.barrier } : {}),
      });
      repo.events.push(`persist-end:${nth}:${outcome}`);
      if (outcome === "accepted") {
        repo.committed.push(nth);
        repo.committedSizes.push(messages.length);
      }
      return outcome;
    },
  };
});

import { useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant, useAssistantStore } from "@/lib/ai/assistant/store";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { readLifecycleLog, resetLifecycleLog } from "@/lib/ai/assistant/lifecycle";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { useAssistantSession, type AssistantSession } from "./use-assistant-session";
import { LifecycleNotice, RefusalNotice } from "./assistant-conversation";

const AGENT_ID = "scheduler:thread";
const SCENARIO_ID = "scenario-a";
const TOOL_NAME = "get_schedule_overview";

const BASE_WRITER: WriterContext = {
  scenarioId: SCENARIO_ID,
  documentRevision: 12,
  leaseEpoch: 4,
  scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01", rangeEnd: "2026-09-30" },
};
let writerContext: WriterContext | null = BASE_WRITER;

vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/ai/assistant/writer-context", () => ({
  readWriterContext: async () => writerContext,
}));

const realAgent = vi.hoisted(() => ({ current: null as unknown }));
const realCore = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@copilotkit/react-core/v2", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useAgent: () => ({ agent: realAgent.current, isReady: true }),
    useCopilotKit: () => ({ copilotkit: realCore.current }),
    useFrontendTool: () => {},
  };
});

/** Which shape the transport plays for a turn. */
type Shape = "answer" | "toolThenAnswer" | "toolThenSilentFollowUp";

class ScriptedAgent extends AbstractAgent {
  shape: Shape = "answer";
  answer = "an answer";
  readonly hopInputs: RunAgentInput[] = [];
  readonly clones: ScriptedAgent[] = [];
  /** Counts the TEXT_MESSAGE_END events this transport actually emitted. */
  textBoundaries = 0;
  private hop = 0;

  constructor() {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.hopInputs.push(input);
    const nth = (this.hop += 1);
    const callId = `${input.runId}-call`;
    const shape = this.shape;
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: unknown) => subscriber.next(event as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });

      const wantsTool = shape !== "answer" && nth === 1;
      if (wantsTool) {
        emit({
          type: "TOOL_CALL_START",
          parentMessageId: `msg-${callId}`,
          toolCallId: callId,
          toolCallName: TOOL_NAME,
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: "{}" });
        emit({ type: "TOOL_CALL_END", toolCallId: callId });
      } else if (shape === "toolThenSilentFollowUp" && nth === 2) {
        // THE POINT OF THIS SHAPE: the follow-up produces no text boundary at all, so
        // nothing but the final drained snapshot can persist the completed pair.
      } else {
        const messageId = `${input.runId}-answer`;
        emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: this.answer });
        emit({ type: "TEXT_MESSAGE_END", messageId });
        this.textBoundaries += 1;
      }

      emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      subscriber.complete();
    });
  }

  override clone(): ScriptedAgent {
    const copy = new ScriptedAgent();
    copy.shape = this.shape;
    copy.answer = this.answer;
    copy.threadId = this.threadId;
    Object.defineProperty(copy, "textBoundaries", {
      get: () => this.textBoundaries,
      set: (value: number) => {
        this.textBoundaries = value;
      },
    });
    this.clones.push(copy);
    copy.setMessages([...this.messages]);
    return copy;
  }
}

let harness: AssistantHarness;
let threadId: string;
let agent: ScriptedAgent;
const session: { current: AssistantSession | null } = { current: null };
const unhandled: unknown[] = [];

function Host() {
  session.current = useAssistantSession({
    threadId,
    routePath: "/shift-requests",
    routeLabel: "Requests",
    historical: false,
  });
  return (
    <>
      <RefusalNotice />
      <LifecycleNotice />
    </>
  );
}

function onUnhandled(event: PromiseRejectionEvent) {
  unhandled.push(event.reason);
}

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();
  writerContext = BASE_WRITER;
  unhandled.length = 0;
  // Module-global and bounded; cleared so "exactly one report" is a claim about THIS
  // turn rather than about everything the file has run so far.
  resetLifecycleLog();
  window.addEventListener("unhandledrejection", onUnhandled);

  repo.entered = 0;
  repo.gate = null;
  repo.waiting = null;
  repo.blockOn = new Set();
  repo.rejectOn = new Set();
  repo.rejectWhen = null;
  repo.barrier = null;
  repo.currentNth = 0;
  repo.currentHasAssistant = false;
  repo.events = [];
  repo.rejected = [];
  repo.committed = [];
  repo.committedSizes = [];

  agent = new ScriptedAgent();
  realAgent.current = agent;
  realCore.current = new CopilotKitCore({
    runtimeUrl: "http://localhost/api/copilotkit",
    agents__unsafe_dev_only: { [AGENT_ID]: agent },
  });
  (realCore.current as CopilotKitCore).addTool({
    name: TOOL_NAME,
    description: "Read the schedule.",
    agentId: AGENT_ID,
    parameters: z.object({}),
    handler: async () => "the tool result",
  });

  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/copilotkit")) {
      return new Response(
        JSON.stringify({ agents: {}, mode: "sse", runtimeInstanceId: "instance-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  useAuthorityStore.setState({
    scenarioId: SCENARIO_ID,
    documentRevision: 12,
    recordRevision: 20,
    ownership: "owner",
  });
  threadId = (await selectActiveThread(SCENARIO_ID)).threadId;

  render(<Host />);
  await waitFor(() => expect(session.current).not.toBeNull());
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", onUnhandled);
  cleanup();
  vi.restoreAllMocks();
});

async function lastTurn() {
  const turns = (await harness.db.assistantTurns.toArray()).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return turns.at(-1);
}

/** Let queued microtasks and the persistence chain settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("a write whose turn dies while it waits in the queue", () => {
  it("reaches the queue decision, never commits, and leaves Stop's story intact", async () => {
    // Write 1 blocks; the tool boundary and the final snapshot queue behind it; Stop
    // lands; then write 1 is released.
    agent.shape = "toolThenAnswer";
    repo.blockOn.add(1);

    const sent = session.current!.send("why is the 15th short?");
    await waitFor(() => expect(repo.entered).toBeGreaterThan(0));

    // Non-vacuity: a write really is in flight and holding the queue.
    expect(repo.gate).not.toBeNull();
    const committedBeforeStop = repo.committed.length;

    await act(async () => {
      session.current!.stop();
      await waitFor(() => expect(useAssistantStore.getState().interruption).toBeNull());
    });

    // Release the blocked write and let everything behind it drain.
    repo.gate?.();
    await act(async () => {
      await sent;
    });
    await settle();

    // Whatever was queued after the revocation did not commit.
    expect(repo.committed.length).toBe(committedBeforeStop + (repo.committed.length ? 1 : 0));
    // Stop's truthful row survived.
    const turn = await lastTurn();
    expect(turn?.terminalReason).not.toBe("completed");
    // And no rejection escaped.
    expect(unhandled).toEqual([]);
  });
});

describe("a rejected write does not poison the queue", () => {
  // Entry 1 is the send's own direct write of the user's message, which is not part of
  // the queue; the queued boundary writes start at entry 2.
  it.each([
    ["the first queued", 2],
    ["a middle queued", 3],
  ])("recovers when %s write rejects", async (_label, nth) => {
    agent.shape = "toolThenAnswer";
    repo.rejectOn.add(nth);

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    // The intended write really did reject -- otherwise this proves nothing.
    expect(repo.rejected).toContain(nth);
    // A later write still executed.
    expect(repo.entered).toBeGreaterThan(nth);
    // No unhandled rejection escaped the chain.
    expect(unhandled).toEqual([]);

    // Exactly one bounded report, and it carries no error detail.
    const failures = readLifecycleLog().filter((event) => event.errorClass === "persist_failed");
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).not.toContain("storage rejected");
    expect(document.body.innerHTML).not.toContain("storage rejected");

    // A turn whose history did not land is not a completed turn.
    const turn = await lastTurn();
    expect(turn?.terminalReason).not.toBe("completed");
  });

  it("recovers when the FINAL queued write rejects", async () => {
    // The one position the index-driven cases cannot name, and the one that matters
    // most: there is no later write to paper over it, so if the settlement path took a
    // rejection here as success the turn would be recorded as completed with an answer
    // that never reached disk.
    agent.shape = "toolThenAnswer";
    // Two writes carry the answer: the text boundary, then the settlement snapshot. They
    // are byte-identical, so only their ORDER tells them apart -- and the assertion
    // below that nothing entered afterwards is what proves the second one is the final
    // write rather than an assumption about how many boundaries this shape has.
    let carryingAnswer = 0;
    repo.rejectWhen = (messages) => {
      const last = messages.at(-1);
      const isAnswer =
        last?.role === "assistant" && String(last.content ?? "").includes(agent.answer);
      return isAnswer && (carryingAnswer += 1) === 2;
    };

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    // It rejected, and it really was the last write -- nothing entered behind it.
    expect(repo.rejected).toHaveLength(1);
    expect(repo.entered).toBe(repo.rejected[0]);
    // Earlier writes still committed, so the queue was not poisoned from the front.
    expect(repo.committed.length).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);

    const failures = readLifecycleLog().filter((event) => event.errorClass === "persist_failed");
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).not.toContain("storage rejected");
    expect(document.body.innerHTML).not.toContain("storage rejected");

    const turn = await lastTurn();
    expect(turn?.terminalReason).not.toBe("completed");
  });
});

describe("revocation INSIDE the real repository transaction", () => {
  // The queue barrier proves the queue. It cannot prove the transaction, because it
  // stops a write before the repository is entered -- so the execution recheck catches
  // it and the commit window is never opened. These suspend the real
  // `persistThreadMessages` at each point where it has just checked authority and
  // found it good, then take that authority away. What must follow is a whole-write
  // rollback: not a shorter write, not a prefix, nothing.

  /**
   * Revoke authority at `point`, synchronously, from inside the transaction.
   *
   * Synchronous on purpose. Suspending the transaction and revoking from outside would
   * hold an IndexedDB transaction open across other Dexie work and deadlock the very
   * controller doing the revoking -- and every trigger here closes its gate
   * synchronously anyway, which is precisely the property that makes it visible to the
   * next in-transaction check. So this reproduces the real window exactly: authority
   * was good when the step before it ran, and is gone by the check after it.
   */
  function revokeAt(point: string, revoke: () => void) {
    let used = false;
    repo.barrier = (at) => {
      if (used || at !== point || !repo.currentHasAssistant) return;
      used = true;
      // OUTSIDE THE PARENT TRANSACTION'S ZONE, and this is not incidental.
      //
      // Dexie propagates the current transaction through async context, so a
      // `db.transaction(...)` opened from inside this callback becomes a SUB-transaction
      // of the write under test and inherits its table set. Clear needs
      // `assistantSettings`, which a history write does not include, so Clear failed
      // with `SubTransactionError` and never ran -- no generation bump, no cleared
      // thread, no deletion pass. That is an artifact of where the test stands, not of
      // the product: a real Clear is issued from an event handler, outside any
      // transaction. `ignoreTransaction` puts the revocation back where it belongs, and
      // it still runs SYNCHRONOUSLY, so the gate is closed before the next check.
      Dexie.ignoreTransaction(revoke);
    };
    return { engaged: () => used };
  }

  /**
   * Every assistant/tool message id this transport minted for the run so far.
   *
   * Read from the CLONES: each turn runs on its own instance, so the panel agent's own
   * `hopInputs` is empty and an id list built from it would assert nothing.
   */
  function providerMessageIds() {
    return agent.clones
      .flatMap((clone) => clone.hopInputs)
      .flatMap((hop) => [`msg-${hop.runId}-call`, `${hop.runId}-call`, `${hop.runId}-answer`]);
  }

  it.each(["thread-read", "turn-read", "history-read", "put", "before-return"])(
    "rolls the whole write back when Stop lands at the %s barrier",
    async (point) => {
      agent.shape = "toolThenAnswer";
      // `stop()` closes the in-memory gate synchronously, which is what the next
      // in-transaction check sees.
      const barrier = revokeAt(point, () => session.current!.stop());

      await act(async () => {
        await session.current!.send("why is the 15th short?");
      });
      await settle();

      // Non-vacuity: the write really did reach that point, past a check that passed.
      expect(barrier.engaged()).toBe(true);

      // NOTHING of the revoked write survived -- not a prefix, not one row.
      const rows = await harness.db.assistantMessages.toArray();
      expect(rows.map((row) => row.role)).toEqual(["user"]);
      for (const id of providerMessageIds()) {
        expect(rows.map((row) => row.messageId)).not.toContain(id);
      }
      // The user's own prompt is untouched: it was written under real authority, before
      // any of this, and losing it would be the compensation clobbering valid history.
      expect(rows[0]?.content).toBe("why is the 15th short?");

      // Nothing visible claims otherwise either. Awaited rather than sampled: the
      // reconcile is an effect that re-reads disk once the interruption settles, so
      // the panel catches up a tick after the durable rollback it is following.
      await waitFor(() => {
        const visible = (realAgent.current as ScriptedAgent).messages;
        expect(visible.filter((message) => message.role !== "user")).toEqual([]);
      });

      // And the turn is not recorded as having completed.
      const turn = await lastTurn();
      expect(turn?.terminalReason).not.toBe("completed");
      expect(unhandled).toEqual([]);
    },
  );

  it.each(["takeover", "disable", "clear_all"] as const)(
    "rolls the whole write back when %s lands mid-transaction",
    async (trigger) => {
      // Driven through the controller the product itself uses for these triggers,
      // rather than through `setEnabled`/`clearAll`. Those write settings rows first,
      // and the extra durable step buys nothing here: the controller's gate closes
      // SYNCHRONOUSLY on entry, which is the revocation the write has to see, and it
      // is the same closure the wrappers delegate to.
      agent.shape = "toolThenAnswer";
      const barrier = revokeAt("put", () => {
        void assistantActions.interrupt({ trigger, threadId, scenarioId: SCENARIO_ID });
      });

      await act(async () => {
        await session.current!.send("why is the 15th short?");
      });
      await settle();

      expect(barrier.engaged()).toBe(true);

      // Clear deletes the thread outright; the others leave it with the prompt alone.
      // Either way, not one assistant or tool row of the revoked turn is durable.
      const rows = await harness.db.assistantMessages.toArray();
      expect(rows.filter((row) => row.role !== "user")).toEqual([]);
      for (const id of providerMessageIds()) {
        expect(rows.map((row) => row.messageId)).not.toContain(id);
      }
      expect(unhandled).toEqual([]);
    },
  );

  it("lets an authorized twin commit, so the rollbacks above are not the only outcome", async () => {
    // The control. Same shape, same barrier point, released WITHOUT revoking.
    agent.shape = "toolThenAnswer";
    const barrier = revokeAt("put", () => {});

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    expect(barrier.engaged()).toBe(true);
    const rows = await harness.db.assistantMessages.toArray();
    expect(rows.some((row) => row.role === "assistant")).toBe(true);
    expect(repo.committed.length).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });

  it("leaves B undelayed and unpolluted when A is revoked mid-transaction", async () => {
    agent.shape = "toolThenAnswer";
    const barrier = revokeAt("put", () => session.current!.stop());

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    expect(barrier.engaged()).toBe(true);
    const aIds = providerMessageIds();

    // B waits for the interruption to finish, exactly as a user does: the gate is
    // closed until settlement completes, so a send issued before then is refused as
    // `interrupting` and would prove nothing about pollution.
    await waitFor(() => expect(session.current!.interrupting).toBe(false));

    const clonesBeforeB = agent.clones.length;
    await act(async () => {
      await session.current!.send("and the 16th?");
    });
    await settle();

    // B ran on its own clone, and its FIRST hop carries none of A's ids.
    expect(agent.clones.length).toBeGreaterThan(clonesBeforeB);
    const firstBHop = agent.clones[clonesBeforeB].hopInputs[0];
    expect(firstBHop).toBeDefined();
    const carried = firstBHop.messages.map((message) => message.id);
    for (const id of aIds) expect(carried).not.toContain(id);
    // B's own answer is durable, so the rollback did not poison the thread.
    const rows = await harness.db.assistantMessages.toArray();
    expect(rows.some((row) => row.role === "assistant")).toBe(true);
    expect(unhandled).toEqual([]);
  });
});

describe("the success twins a silent turn is judged against", () => {
  // NON-VACUITY FOR THE WHOLE RULE. A turn is `completed` only when it produced new
  // assistant text, so these two are what stop that rule from simply failing everything.

  it("a direct text answer completes", async () => {
    agent.shape = "answer";
    agent.answer = "a real answer";

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    const turn = await lastTurn();
    expect(turn?.terminalReason).toBe("completed");
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
  });

  it("a tool call, its result and a real follow-up answer completes", async () => {
    agent.shape = "toolThenAnswer";
    agent.answer = "the follow-up answer";

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    // Genuinely two hops with a tool result between them -- the shape a working
    // grounded turn has, and the one the live turn never reached.
    const ran = agent.clones.at(-1)!;
    expect(ran.hopInputs).toHaveLength(2);
    const rows = await harness.db.assistantMessages.toArray();
    expect(rows.some((row) => row.role === "tool")).toBe(true);

    const turn = await lastTurn();
    expect(turn?.terminalReason).toBe("completed");
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
  });
});

describe("a completed pair with no later text boundary", () => {
  it("is durable because the final snapshot drains before authority is released", async () => {
    agent.shape = "toolThenSilentFollowUp";

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });
    await settle();

    const ran = agent.clones.at(-1)!;
    // The event shape genuinely lacks the later boundary: two hops, no TEXT_MESSAGE_END.
    expect(ran.hopInputs).toHaveLength(2);
    expect(agent.textBoundaries).toBe(0);

    // THE COMPLETE PAIR IS NONETHELESS DURABLE, which is this test's subject: the
    // snapshot drains before authority is released, so the tool result survives even
    // though no later text boundary ever arrived.
    const rows = await harness.db.assistantMessages.toArray();
    const text = JSON.stringify(rows);
    expect(text).toContain("the tool result");
    expect(rows.some((row) => row.role === "tool")).toBe(true);

    // AND THE TURN IS NOT CALLED COMPLETE. A tool call whose follow-up came back silent
    // leaves the user with no reply, so the artifacts it did produce are kept under
    // their own rules while the turn itself settles as a bounded failure and the panel
    // offers the retry notice. This assertion used to say `completed`, and that is the
    // half of the live defect the schema fix alone would not have reached.
    const turn = await lastTurn();
    expect(turn?.terminalReason).toBe("run_failed");
  });
});

describe("a late THROW takes the same silent path as a late resolve", () => {
  it("publishes no notice and leaves the newer turn's DOM and store untouched", async () => {
    // The resolve branch is covered in `session-real-core.test.tsx`. The catch branch
    // is a DIFFERENT arm of the same settlement, so it gets its own proof: A's tool
    // throws rather than returning, after Stop and after B has answered.
    let releaseA: (() => void) | undefined;
    const aSuspended = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let calls = 0;
    let aThrew = false;

    const core = realCore.current as CopilotKitCore;
    core.setToolEnabled(TOOL_NAME, true, AGENT_ID);
    core.removeTool(TOOL_NAME, AGENT_ID);
    core.addTool({
      name: TOOL_NAME,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        calls += 1;
        if (calls === 1) {
          await aSuspended;
          aThrew = true;
          throw new Error("A's tool blew up");
        }
        return "B's tool result";
      },
    });

    agent.shape = "toolThenAnswer";
    agent.answer = "A's answer";
    const aSent = session.current!.send("first question");
    await waitFor(() => expect(calls).toBe(1));

    await act(async () => {
      session.current!.stop();
      await waitFor(() => expect(useAssistantStore.getState().interruption).toBeNull());
    });

    cleanup();
    agent.answer = "B's answer";
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());
    await act(async () => {
      await session.current!.send("second question");
    });

    const domBefore = document.body.innerHTML;
    const storeBefore = JSON.stringify(useAssistantStore.getState());

    releaseA?.();
    await act(async () => {
      await aSent;
    });
    await settle();

    // The throw really happened -- otherwise this branch was never taken.
    expect(aThrew).toBe(true);
    // And it published nothing: rendered surface and store are byte-for-byte unchanged.
    expect(document.body.innerHTML).toBe(domBefore);
    expect(document.body.innerHTML).not.toContain("assistant-refusal");
    expect(JSON.stringify(useAssistantStore.getState())).toBe(storeBefore);
    expect(unhandled).toEqual([]);
  });
});

describe("dirty history already on disk", () => {
  it("is normalized in the panel and in B's FIRST provider hop, and deleted", async () => {
    // Seeded BEFORE the send, as an older build or a crash would have left it: an
    // out-of-order result, a duplicate call, and a dangling call, alongside valid
    // ordinary history. Exact ids, so nothing here can pass vacuously.
    const control = await selectActiveThread("scenario-control");
    const seedRow = async (thread: string, scenario: string, row: Record<string, unknown>) => {
      await harness.db.assistantMessages.put({
        schemaVersion: 1,
        threadId: thread,
        scenarioId: scenario,
        content: "",
        toolCalls: null,
        toolCallId: null,
        modelId: null,
        turnId: null,
        globalGeneration: 0,
        scenarioGeneration: 0,
        createdAt: new Date().toISOString(),
        ...row,
      } as never);
    };

    await seedRow(threadId, SCENARIO_ID, {
      messageId: "valid-user",
      seq: 1,
      role: "user",
      content: "an earlier question",
    });
    // Result before its call.
    await seedRow(threadId, SCENARIO_ID, {
      messageId: "early-result",
      seq: 2,
      role: "tool",
      content: "early",
      toolCallId: "dirty-out-of-order",
    });
    await seedRow(threadId, SCENARIO_ID, {
      messageId: "late-call",
      seq: 3,
      role: "assistant",
      toolCalls: [{ toolCallId: "dirty-out-of-order", name: "t", args: "{}" }],
    });
    // A dangling call with no result at all.
    await seedRow(threadId, SCENARIO_ID, {
      messageId: "dangling",
      seq: 4,
      role: "assistant",
      toolCalls: [{ toolCallId: "dirty-dangling", name: "t", args: "{}" }],
    });
    // The control thread, which must not be touched at all.
    await seedRow(control.threadId, "scenario-control", {
      messageId: "control-dangling",
      seq: 1,
      role: "assistant",
      toolCalls: [{ toolCallId: "control-call", name: "t", args: "{}" }],
    });
    const controlBefore = JSON.stringify(
      await harness.db.assistantMessages.where("threadId").equals(control.threadId).toArray(),
    );

    // MOUNTED AFTER THE DIRT, which is the case that matters. Seeding into an already
    // mounted panel proves send-time normalization and nothing about hydration -- and
    // hydration is the path a user actually takes: they open a browser onto whatever a
    // crashed or older build left on disk.
    cleanup();
    agent = new ScriptedAgent();
    realAgent.current = agent;
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());

    // BEFORE ANY SEND: the visible agent is already clean.
    await waitFor(() => expect(agent.messages.length).toBeGreaterThan(0));
    const hydrated = JSON.stringify(agent.messages);
    expect(hydrated).not.toContain("dirty-out-of-order");
    expect(hydrated).not.toContain("dirty-dangling");
    expect(hydrated).toContain("an earlier question");

    agent.shape = "answer";
    agent.answer = "a clean answer";

    await act(async () => {
      await session.current!.send("a new question");
    });
    await settle();

    const ran = agent.clones.at(-1)!;
    // THE FIRST HOP, not the follow-up: the dirty ids must never reach the provider.
    const firstHop = JSON.stringify(ran.hopInputs[0]?.messages ?? []);
    expect(firstHop).not.toContain("dirty-out-of-order");
    expect(firstHop).not.toContain("dirty-dangling");
    // Non-vacuity: the valid history really did survive into that same hop.
    expect(firstHop).toContain("an earlier question");

    // The visible panel is normalized too.
    const visible = JSON.stringify(agent.messages);
    expect(visible).not.toContain("dirty-out-of-order");
    expect(visible).not.toContain("dirty-dangling");

    // The invalid rows are DELETED, not merely skipped -- valid ones remain.
    const rows = await harness.db.assistantMessages.where("threadId").equals(threadId).toArray();
    const ids = rows.map((row) => row.messageId);
    expect(ids).not.toContain("early-result");
    expect(ids).not.toContain("late-call");
    expect(ids).not.toContain("dangling");
    expect(ids).toContain("valid-user");

    // The control thread is byte-for-byte untouched.
    expect(
      JSON.stringify(
        await harness.db.assistantMessages.where("threadId").equals(control.threadId).toArray(),
      ),
    ).toBe(controlBefore);
  });
});

describe("Clear all against a live turn", () => {
  // Clear is the strictest of the triggers: not "this turn's rows must not land" but
  // "no assistant content may exist at all afterwards, and nothing may put it back".
  // So these assert emptiness across every content table, not just the write under
  // test, and they check the one thing that could quietly undo it -- the fence
  // returning to a value an old writer still satisfies.

  /**
   * Every table Clear is responsible for emptying.
   *
   * `diagnosticSearches` is here because it once was not, in the production table set
   * and in this assertion at the same time -- so a completed infeasibility search
   * survived a Clear all that claimed to remove every local AI record, and no test
   * noticed. `optimizeBases` is deliberately excluded and asserted separately: ordinary
   * Optimize is not assistant data.
   */
  async function contentCounts() {
    return {
      threads: await harness.db.assistantThreads.count(),
      turns: await harness.db.assistantTurns.count(),
      messages: await harness.db.assistantMessages.count(),
      settings: await harness.db.assistantSettings.count(),
      proposals: await harness.db.assistantProposals.count(),
      receipts: await harness.db.assistantReceipts.count(),
      searches: await harness.db.diagnosticSearches.count(),
    };
  }

  /**
   * Put a real row in every table Clear touches, plus one it must not.
   *
   * Without this the emptiness assertions are close to vacuous: a table that was empty
   * before Clear is empty afterwards whatever Clear does.
   */
  async function seedAssistantContent() {
    const at = new Date().toISOString();
    await harness.db.assistantProposals.put({
      proposalId: "proposal-1",
      scenarioId: SCENARIO_ID,
      schemaVersion: 1,
      createdAt: at,
    } as never);
    await harness.db.assistantReceipts.put({
      receiptId: "receipt-1",
      scenarioId: SCENARIO_ID,
      schemaVersion: 1,
      createdAt: at,
    } as never);
    await harness.db.diagnosticSearches.put({
      searchId: "search-1",
      scenarioId: SCENARIO_ID,
      schemaVersion: 1,
      createdAt: at,
    } as never);
    // A search belonging to ANOTHER scenario, so Clear all's global reach is a real
    // claim rather than an accident of there being only one scenario.
    await harness.db.diagnosticSearches.put({
      searchId: "search-other",
      scenarioId: "scenario-other",
      schemaVersion: 1,
      createdAt: at,
    } as never);
    // Ordinary Optimize evidence. Assistant Clear must not touch it.
    await harness.db.optimizeBases.put({
      basisId: "basis-1",
      scenarioId: SCENARIO_ID,
      schemaVersion: 1,
      createdAt: at,
    } as never);
    // The in-memory card the user is looking at.
    assistantActions.publishDiagnostic({ searchId: "search-1" } as never, 1);

    return JSON.stringify(await harness.db.optimizeBases.toArray());
  }

  function clearAll() {
    // Outside the parent transaction's zone -- see `revokeAt`. A real Clear is issued
    // from an event handler, never from inside a write.
    Dexie.ignoreTransaction(() => {
      void assistantActions.interrupt({
        trigger: "clear_all",
        threadId: null,
        scenarioId: SCENARIO_ID,
      });
    });
  }

  /** Every assistant/tool id the transport minted, across all per-turn clones. */
  function providerIds() {
    return agent.clones
      .flatMap((clone) => clone.hopInputs)
      .flatMap((hop) => [`msg-${hop.runId}-call`, `${hop.runId}-call`, `${hop.runId}-answer`]);
  }

  /** The ordinary Optimize rows as they were before the Clear under test. */
  let basesBefore = "[]";

  // Seeded for EVERY case in this block -- barrier, queue and remount alike -- so no
  // case can assert emptiness about a table that was already empty.
  beforeEach(async () => {
    basesBefore = await seedAssistantContent();
  });

  async function expectClearedCompletely() {
    await waitFor(() => expect(session.current!.interrupting).toBe(false));
    await settle();

    // Every content table empty -- including the diagnostic searches Clear all once
    // left behind.
    expect(await contentCounts()).toEqual({
      threads: 0,
      turns: 0,
      messages: 0,
      settings: 0,
      proposals: 0,
      receipts: 0,
      searches: 0,
    });

    // The card the user was looking at is gone with the row it described.
    expect(useAssistantStore.getState().activeDiagnostic).toBeNull();

    // ORDINARY OPTIMIZE IS UNTOUCHED, byte for byte. Clearing the assistant must not
    // erase a nurse's feasibility evidence.
    expect(JSON.stringify(await harness.db.optimizeBases.toArray())).toBe(basesBefore);

    // THE FENCE SURVIVED, AND MOVED. This is the ABA check: the generation rows are
    // the one thing Clear must never delete, because a fresh row would mint at 0 and
    // an old writer's captured 0 would match it again. They are non-content counters --
    // a scope key and an integer -- so retaining them costs the user nothing.
    const generations = await harness.db.assistantGenerations.toArray();
    expect(generations.length).toBeGreaterThan(0);
    for (const row of generations) expect(row.generation).toBeGreaterThan(0);

    // Nothing visible, and no id of the cleared turn anywhere.
    await waitFor(() => expect((realAgent.current as ScriptedAgent).messages).toEqual([]));
    const durable = JSON.stringify(await harness.db.assistantMessages.toArray());
    for (const id of providerIds()) expect(durable).not.toContain(id);

    expect(unhandled).toEqual([]);
  }

  it.each(["thread-read", "turn-read", "history-read", "put", "before-return"])(
    "leaves no assistant data when it lands at the %s barrier",
    async (point) => {
      agent.shape = "toolThenAnswer";
      let engaged = false;
      repo.barrier = (at) => {
        if (engaged || at !== point || !repo.currentHasAssistant) return;
        engaged = true;
        clearAll();
      };

      await act(async () => {
        await session.current!.send("why is the 15th short?");
      });
      // Non-vacuity: the write really did reach that point, past a check that passed.
      expect(engaged).toBe(true);

      await expectClearedCompletely();
    },
  );

  it("leaves no assistant data when it lands while a write waits in the queue", async () => {
    // The other window: not inside a transaction, but behind one. The blocked write
    // holds the queue, so the boundaries after it are still pending when Clear starts.
    agent.shape = "toolThenAnswer";
    repo.blockOn.add(2);

    const sent = session.current!.send("why is the 15th short?");
    await waitFor(() => expect(repo.entered).toBeGreaterThan(1));
    expect(repo.gate).not.toBeNull();

    act(() => {
      clearAll();
    });
    repo.gate?.();
    await act(async () => {
      await sent;
    });

    await expectClearedCompletely();
  });

  it("leaves no assistant data when the panel remounts across it", async () => {
    // Hydration is the way deleted content comes back: a panel that mounts while the
    // deletion pass is in flight reads the thread, and a stale read would repopulate
    // the visible list with a conversation the user just deleted.
    agent.shape = "toolThenAnswer";
    repo.blockOn.add(2);

    const sent = session.current!.send("why is the 15th short?");
    await waitFor(() => expect(repo.entered).toBeGreaterThan(1));

    act(() => {
      clearAll();
    });
    cleanup();
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());

    repo.gate?.();
    await act(async () => {
      await sent;
    });

    await expectClearedCompletely();
  });
});

describe("a write already open when authority closes", () => {
  // WHY NOTHING WAITS FOR THESE WRITES. `persistThreadMessages` and the terminal
  // `setTurnState` both run `runFenced` over ASSISTANT_WRITE_TABLES -- the same four
  // tables, the same database, both `readwrite`. IndexedDB serialises overlapping
  // `readwrite` transactions in creation order, so a write already open finishes
  // before settlement can begin, and one not yet open begins after the gate closed and
  // is refused by the in-memory check and the durable unsettled-turn comparison. Clear
  // is the same argument over a superset of those tables.
  //
  // These tests assert that ordering directly rather than asserting a mechanism that
  // enforces it, which is why an explicit drain was removed: no test could tell it
  // apart from the ordering the store already provides.

  /** Suspend the write that is currently inside the repository, at `point`. */
  function suspendAt(point: string) {
    let release!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = { nth: 0 };
    repo.barrier = async (at) => {
      if (held.nth || at !== point || !repo.currentHasAssistant) return;
      held.nth = repo.currentNth;
      arrived();
      await gate;
    };
    return { reached, release, held };
  }

  /** Every assistant/tool id the transport minted, across all per-turn clones. */
  function mintedIds() {
    return agent.clones
      .flatMap((clone) => clone.hopInputs)
      .flatMap((hop) => [`msg-${hop.runId}-call`, `${hop.runId}-call`, `${hop.runId}-answer`]);
  }

  /** Start an interruption from OUTSIDE any transaction, as the product does. */
  function interruptExternally(trigger: "stop" | "takeover" | "clear_all") {
    let running!: Promise<unknown>;
    Dexie.ignoreTransaction(() => {
      running = assistantActions
        .interrupt({
          trigger,
          threadId: trigger === "clear_all" ? null : threadId,
          scenarioId: SCENARIO_ID,
        })
        .then(() => {
          repo.events.push("settlement");
        });
    });
    return running;
  }

  it.each(["stop", "takeover", "clear_all"] as const)(
    "resolves before %s settlement is observable, and leaves no A bytes",
    async (trigger) => {
      agent.shape = "toolThenAnswer";
      const barrier = suspendAt("before-return");

      let sent!: Promise<unknown>;
      act(() => {
        sent = session.current!.send("why is the 15th short?");
      });
      await barrier.reached;
      // Non-vacuity: a real transaction is genuinely held open, past a true guard.
      expect(barrier.held.nth).toBeGreaterThan(0);

      const settling = interruptExternally(trigger);
      barrier.release();
      await act(async () => {
        await Promise.all([settling, sent]);
      });
      await settle();

      // THE ORDERING CLAIM: the held write reached its own conclusion -- commit or
      // rollback -- strictly before settlement became observable. Nothing waited for
      // it; the store's transaction ordering is what put it first.
      const held = repo.events.findIndex((event) =>
        event.startsWith(`persist-end:${barrier.held.nth}:`),
      );
      const settled = repo.events.indexOf("settlement");
      expect(held).toBeGreaterThanOrEqual(0);
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(held).toBeLessThan(settled);

      // And the fate of A's own bytes is the expected one for the trigger.
      const rows = await harness.db.assistantMessages.toArray();
      const ids = rows.map((row) => row.messageId);
      for (const id of mintedIds()) expect(ids).not.toContain(id);
      if (trigger === "clear_all") {
        expect(rows).toEqual([]);
        const generations = await harness.db.assistantGenerations.toArray();
        expect(generations.length).toBeGreaterThan(0);
        for (const row of generations) expect(row.generation).toBeGreaterThan(0);
      } else {
        // The user's own prompt is pre-revocation history and stays.
        expect(rows.map((row) => row.role)).toEqual(["user"]);
      }
      expect(unhandled).toEqual([]);
    },
  );

  it("suppresses every writer queued behind it, with nothing draining them", async () => {
    // The second half of the derivation: writes that had NOT opened a transaction when
    // authority closed. Each reaches its queue decision and stops there -- the cheap
    // execution recheck refuses it before the repository is entered, so it never even
    // reaches the durable comparison. Nothing cancels them and nothing drains them.
    agent.shape = "toolThenAnswer";
    const barrier = suspendAt("before-return");

    let sent!: Promise<unknown>;
    act(() => {
      sent = session.current!.send("why is the 15th short?");
    });
    await barrier.reached;
    const heldNth = barrier.held.nth;

    const settling = interruptExternally("stop");
    barrier.release();
    await act(async () => {
      await Promise.all([settling, sent]);
    });
    await settle();

    // Not one writer got past the queue, and none committed.
    expect(repo.entered).toBe(heldNth);
    expect(repo.committed.filter((nth) => nth > heldNth)).toEqual([]);
    const rows = await harness.db.assistantMessages.toArray();
    expect(rows.map((row) => row.role)).toEqual(["user"]);

    // NON-VACUITY, and it needs stating: "nothing entered" is only meaningful if this
    // shape has boundaries left to enter. An authorized turn of the SAME shape, run
    // straight afterwards, enters several more -- so the silence above is suppression
    // rather than a shape that had nothing more to write.
    const enteredAfterA = repo.entered;
    await waitFor(() => expect(session.current!.interrupting).toBe(false));
    await act(async () => {
      await session.current!.send("and the 16th?");
    });
    await settle();
    expect(repo.entered).toBeGreaterThan(enteredAfterA + 1);
    expect(unhandled).toEqual([]);
  });
});

describe("the enqueued payload is a deep copy", () => {
  it("commits the bytes authorized at enqueue, not the ones the agent grew afterwards", async () => {
    // The clone's message OBJECTS are the ones CopilotKit keeps growing -- content,
    // tool-call arguments, result payloads. A queued write that held references to
    // them would commit whatever they had become by the time it ran, which after a
    // tool boundary can be a different conversation entirely.
    agent.shape = "toolThenAnswer";
    agent.answer = "the authorized answer";
    repo.blockOn.add(2);

    const sent = session.current!.send("why is the 15th short?");
    await waitFor(() => expect(repo.entered).toBeGreaterThan(1));
    expect(repo.gate).not.toBeNull();

    // MUTATE NESTED REFERENCES, not just the outer array. Every one of these is a
    // distinct way the payload could be rewritten after it was authorized.
    const live = agent.clones.at(-1)!.messages as unknown as Record<string, unknown>[];
    expect(live.length).toBeGreaterThan(0);
    for (const message of live) {
      if (typeof message.content === "string") message.content = "TAMPERED CONTENT";
      const calls = message.toolCalls as { id?: string; function?: Record<string, unknown> }[];
      if (Array.isArray(calls)) {
        for (const call of calls) {
          call.id = "TAMPERED-CALL-ID";
          if (call.function) call.function.arguments = '{"tampered":true}';
        }
      }
      if (message.toolCallId) message.toolCallId = "TAMPERED-CALL-ID";
    }
    live.push({ id: "TAMPERED-EXTRA", role: "assistant", content: "never authorized" });

    repo.gate?.();
    await act(async () => {
      await sent;
    });
    await settle();

    const durable = JSON.stringify(await harness.db.assistantMessages.toArray());
    expect(durable).not.toContain("TAMPERED");
    // Non-vacuity: the write really did commit something, and it is the original.
    expect(repo.committed.length).toBeGreaterThan(0);
    expect(durable).toContain("why is the 15th short?");
  });
});

describe("a slow write across a production remount", () => {
  it("does not delay, poison or leak into the turn that replaces it", async () => {
    agent.shape = "toolThenAnswer";
    agent.answer = "A's answer";
    repo.blockOn.add(1);

    const aSent = session.current!.send("first question");
    await waitFor(() => expect(repo.entered).toBeGreaterThan(0));
    expect(repo.gate).not.toBeNull();

    await act(async () => {
      session.current!.stop();
      await waitFor(() => expect(useAssistantStore.getState().interruption).toBeNull());
    });

    // The panel closes and reopens while A's write is still blocked.
    cleanup();
    agent.answer = "B's answer";
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());

    await act(async () => {
      await session.current!.send("second question");
    });

    // B settled normally, without waiting for A's blocked write.
    const bRows = JSON.stringify(await harness.db.assistantMessages.toArray());
    expect(bRows).toContain("B's answer");

    // Now release A. It must change nothing.
    const domBefore = document.body.innerHTML;
    repo.gate?.();
    await act(async () => {
      await aSent;
    });
    await settle();

    expect(document.body.innerHTML).toBe(domBefore);
    const after = JSON.stringify(await harness.db.assistantMessages.toArray());
    expect(after).toContain("B's answer");
    expect(after).not.toContain("A's answer");
    expect(unhandled).toEqual([]);
  });
});
