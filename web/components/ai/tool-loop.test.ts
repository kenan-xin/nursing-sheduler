// The regression suite for the live-provider blocker: a model called a tool and the
// turn stopped there.
//
// WHY IT IS BUILT LIKE THIS. Every earlier suite drove a HANDLER, a REGISTRY or a
// ROUTE, and all of them passed while the assembled behaviour was inert. The only
// thing that could have caught it is a run driven the way production drives one: a
// real `CopilotKitCore`, a real `AbstractAgent` whose transport is scripted, the real
// provider-hop guard installed through the public `agent.use`, and the real frontend
// tool registry. So that is what this builds. Nothing here stubs the loop it is
// testing.
//
// The fake agent is a TRANSPORT, not a fake CopilotKit: it emits AG-UI events exactly
// as the deployed runtime did when this defect was diagnosed, and every step after
// that -- executing the handler, inserting the tool result, deciding to follow up --
// is CopilotKit's own code.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { z } from "zod";

import {
  createProviderHopGuard,
  currentTurnToken,
  isTurnAuthorized,
  readBoundTurn,
  resetTurnAuthorityForTest,
} from "./turn-authority";
import {
  clearActiveRunHandle,
  readActiveRunHandle,
  setActiveRunHandle,
} from "@/lib/ai/assistant/runtime-stop";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

const AGENT_ID = "scheduler:thread-1";
const TOOL = "get_schedule_overview";

/** One scripted hop: the events the transport emits for that provider round trip. */
type Hop = (input: RunAgentInput) => BaseEvent[];

function toolCallHop(callId: string): Hop {
  return (input) =>
    [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "TOOL_CALL_START",
        parentMessageId: `msg-${callId}`,
        toolCallId: callId,
        toolCallName: TOOL,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: callId, delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: callId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ] as unknown as BaseEvent[];
}

function answerHop(text: string): Hop {
  return (input) =>
    [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: text },
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ] as unknown as BaseEvent[];
}

/** A transport that replays one scripted hop per provider round trip. */
class ScriptedAgent extends AbstractAgent {
  /** Every input that actually reached the transport. Empty means no request. */
  readonly hops: RunAgentInput[] = [];
  script: Hop[];
  private readonly fallback: Hop;

  constructor(script: Hop[], fallback: Hop = answerHop("done")) {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
    this.script = script;
    this.fallback = fallback;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.hops.push(input);
    const hop = this.script.shift() ?? this.fallback;
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of hop(input)) subscriber.next(event);
      subscriber.complete();
    });
  }

  /**
   * Mirrors what CopilotKit's proxied agent does: a fresh instance carrying the same
   * agent id, thread and message history, with its OWN hop log, script and subscriber
   * list. The base implementation cannot know about this subclass's fields, and the
   * separation is precisely what the overlap test is about.
   */
  override clone(): ScriptedAgent {
    const copy = new ScriptedAgent([...this.script], this.fallback);
    copy.threadId = this.threadId;
    copy.setMessages([...this.messages]);
    return copy;
  }
}

function core(): CopilotKitCore {
  // Never dialled — the scripted agent is the transport.
  return new CopilotKitCore({ runtimeUrl: "http://localhost/api/copilotkit" });
}

let bound: TestTurnHandle;

/**
 * Build a guarded agent and bind the turn TO IT.
 *
 * The binding names a concrete agent, and the guard refuses any hop whose bound turn
 * belongs to a different one -- so the fixture has to create the agent first and bind
 * second. Revocations therefore happen after this call, which is also how they happen
 * in life: a turn is authorised, and then something takes its authority away.
 */
function guarded(script: Hop[], fallback?: Hop): ScriptedAgent {
  const agent = new ScriptedAgent(script, fallback);
  bound = bindTurnForTest({ runId: "run-1", agent });
  agent.use(createProviderHopGuard(agent, { readWriterContext: async () => bound.turn.claim }));
  return agent;
}

afterEach(() => {
  resetTurnAuthorityForTest();
});

describe("a model tool call completes the loop", () => {
  it("executes the handler once, inserts its result, follows up, and answers", async () => {
    const handler = vi.fn(async () => "roster period is 1-2 September");
    const kit = core();
    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler,
    });

    const agent = guarded([toolCallHop("call-1"), answerHop("Your roster runs 1-2 Sep.")]);

    await kit.runAgent({ agent, runId: "run-1" });

    // 1. The handler ran, exactly once.
    expect(handler).toHaveBeenCalledTimes(1);

    // 2. Its result was inserted as a tool message the model can read.
    const toolMessage = agent.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(String((toolMessage as { content?: unknown }).content)).toContain("1-2 September");

    // 3. A BOUNDED follow-up happened -- two provider hops, not one and not a loop.
    expect(agent.hops).toHaveLength(2);

    // 4. And the follow-up produced the answer, which is the whole point: before the
    //    fix the turn ended at step 1 with no assistant message at all.
    const answer = agent.messages.filter((message) => message.role === "assistant").at(-1);
    expect(String((answer as { content?: unknown })?.content)).toContain("Your roster runs");
  });

  it("publishes every persistence boundary from BOTH hops to an agent subscriber", async () => {
    // Why the session subscribes to the AGENT rather than passing a subscriber to one
    // run: a per-run subscriber sees the initial hop only, so the answer the follow-up
    // produces would never be persisted and a reload would lose it.
    const kit = core();
    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => "ok",
    });

    const agent = guarded([toolCallHop("call-1"), answerHop("the answer")]);

    const boundaries: string[] = [];
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        if (event.type === "TEXT_MESSAGE_END" || event.type === "TOOL_CALL_END") {
          boundaries.push(event.type);
        }
      },
    });

    await kit.runAgent({ agent, runId: "run-1" });
    subscription.unsubscribe();

    // The tool boundary from hop 1 AND the message boundary from hop 2.
    expect(boundaries).toEqual(["TOOL_CALL_END", "TEXT_MESSAGE_END"]);
  });

  it("carries the registered tools on the hop, so the model can call them", async () => {
    const kit = core();
    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => "ok",
    });

    const agent = guarded([answerHop("hello")]);

    await kit.runAgent({ agent, runId: "run-1" });

    expect(agent.hops[0].tools?.map((tool) => tool.name)).toEqual([TOOL]);
  });
});

describe("the provider-hop guard refuses without sending", () => {
  /** Build a kit + agent whose tool handler can move authority mid-flight. */
  function harness(onTool?: () => void) {
    const kit = core();
    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        onTool?.();
        return "ok";
      },
    });
    const agent = guarded([toolCallHop("call-1"), answerHop("late answer")]);
    return { kit, agent };
  }

  it("makes no request at all when nothing is bound", async () => {
    const { kit, agent } = harness();
    resetTurnAuthorityForTest();

    await kit.runAgent({ agent, runId: "run-1" });

    expect(agent.hops).toEqual([]);
  });

  it("makes no request when the bound turn belongs to a DIFFERENT agent", async () => {
    // The isolation the token exists for: turn B is live, and A's agent must not be
    // able to ride B's authority onto the network.
    const { kit, agent } = harness();
    bound = bindTurnForTest({ runId: "run-b", agent: {} });

    await kit.runAgent({ agent, runId: "run-1" });

    expect(agent.hops).toEqual([]);
  });

  it.each([
    ["a takeover", () => void (bound.turn.claim = { ...bound.turn.claim, leaseEpoch: 99 })],
    ["a lost lease", () => void (bound.live.isOwner = false)],
    ["a revision moving", () => void (bound.live.documentRevision += 1)],
    ["Stop", () => void (bound.live.interrupting = true)],
    ["Disable or Clear moving the epoch", () => void (bound.live.liveTurnEpoch += 1)],
  ])("sends no initial request after %s", async (_label, revoke) => {
    const { kit, agent } = harness();
    revoke();

    await kit.runAgent({ agent, runId: "run-1" });

    expect(agent.hops).toEqual([]);
    expect(bound.turn.refusal).not.toBeNull();
  });

  it.each([
    ["a takeover", () => void (bound.turn.claim = { ...bound.turn.claim, leaseEpoch: 99 })],
    ["a lost lease", () => void (bound.live.isOwner = false)],
    ["a revision moving", () => void (bound.live.documentRevision += 1)],
    ["Stop", () => void (bound.live.interrupting = true)],
    ["Disable or Clear moving the epoch", () => void (bound.live.liveTurnEpoch += 1)],
  ])("sends no FOLLOW-UP request when %s lands during the tool", async (_label, revoke) => {
    // The window the app could not see before: the first hop is authorised, the tool
    // runs, and authority is lost while it does. CopilotKit would follow up; the guard
    // is what stops that second request.
    const { kit, agent } = harness(revoke);

    await kit.runAgent({ agent, runId: "run-1" });

    expect(agent.hops).toHaveLength(1);
    expect(bound.turn.refusal).not.toBeNull();
    // No answer was produced, because no second request was made.
    expect(
      agent.messages.some((m) =>
        String((m as { content?: unknown }).content ?? "").includes("late answer"),
      ),
    ).toBe(false);
  });

  it("is not vacuous: the same harness completes both hops when authority holds", async () => {
    const { kit, agent } = harness();

    await kit.runAgent({ agent, runId: "run-1" });

    expect(agent.hops).toHaveLength(2);
    expect(bound.turn.refusal).toBeNull();
  });
});

describe("a suspended turn cannot authenticate as, or erase, a newer one", () => {
  it("A resumes after detachment and B has started: no effect, no follow-up", async () => {
    // THE OVERLAP. A's tool suspends; A is detached and B binds; A then resumes. With
    // a single mutable slot and no token, A's next check would validate B and A would
    // be free to act -- on A's thread, with A's context, under B's authority.
    const kit = core();

    let releaseA: (() => void) | undefined;
    const aSuspended = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aResumedAuthorized: boolean | null = null;
    let aToken: ReturnType<typeof currentTurnToken> = null;

    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        // Captured at entry, exactly as the shipped handlers do.
        aToken = currentTurnToken();
        await aSuspended;
        // The question the defect got wrong.
        aResumedAuthorized = isTurnAuthorized(aToken);
        return "A's late answer";
      },
    });

    const agentA = guarded([toolCallHop("call-a"), answerHop("A follow-up")]);
    const runA = kit.runAgent({ agent: agentA, runId: "run-1" });
    // Let the first hop land and the handler suspend.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aToken).not.toBeNull();

    // A is detached and B becomes the live turn on its own agent.
    resetTurnAuthorityForTest();
    const agentB = new ScriptedAgent([answerHop("B answer")]);
    const boundB = bindTurnForTest({ runId: "run-b", agent: agentB });
    agentB.use(
      createProviderHopGuard(agentB, { readWriterContext: async () => boundB.turn.claim }),
    );
    const bHopsBefore = agentB.hops.length;
    const bMessagesBefore = agentB.messages.length;

    releaseA?.();
    await runA;

    // A resumed and found it was no longer the bound turn.
    expect(aResumedAuthorized).toBe(false);
    // A made no follow-up request: one hop only, the one it was authorised for.
    expect(agentA.hops).toHaveLength(1);
    // And B is untouched -- its binding, its agent, its messages.
    expect(readBoundTurn()).toBe(boundB.turn);
    expect(agentB.hops).toHaveLength(bHopsBefore);
    expect(agentB.messages).toHaveLength(bMessagesBefore);
    expect(boundB.turn.refusal).toBeNull();

    boundB.release();
  });

  it("A suspends on the SAME logical agent, B starts and settles, A resumes with no effect", async () => {
    // THE REQUIRED OVERLAP, on one logical thread/agent -- the shape the previous test
    // could not reach because it never ran B.
    //
    // Each turn runs on its own `clone()` of the panel's agent, so A and B share an
    // agent id (and therefore a tool registry) while owning separate message lists,
    // subscriber lists and run inputs. Everything below asserts that separation holds
    // in BOTH directions: A does nothing late, and B is untouched.
    const kit = core();
    const panelAgent = new ScriptedAgent([]);

    let releaseA: (() => void) | undefined;
    const aSuspended = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aToken: ReturnType<typeof currentTurnToken> = null;
    let aResumedAuthorized: boolean | null = null;
    let aLateResultDelivered = false;

    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        if (aToken === null) {
          aToken = currentTurnToken();
          await aSuspended;
          aResumedAuthorized = isTurnAuthorized(aToken);
          aLateResultDelivered = true;
          return "A's late tool result";
        }
        return "B's tool result";
      },
    });

    // --- A launches, its tool suspends -------------------------------------
    const agentA = panelAgent.clone() as ScriptedAgent;
    agentA.script = [toolCallHop("call-a"), answerHop("A follow-up")];
    const boundA = bindTurnForTest({ runId: "run-a", agent: agentA });
    agentA.use(
      createProviderHopGuard(agentA, { readWriterContext: async () => boundA.turn.claim }),
    );
    const aSubscriberSaw: string[] = [];
    agentA.subscribe({
      onEvent: ({ event, input }) => {
        if (boundA.turn.ownedRunIds.has(input.runId)) aSubscriberSaw.push(event.type);
      },
    });
    const runA = kit.runAgent({ agent: agentA, runId: "run-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aToken).not.toBeNull();

    // --- A is detached; B starts on its own clone and SETTLES --------------
    resetTurnAuthorityForTest();
    const agentB = panelAgent.clone() as ScriptedAgent;
    agentB.script = [toolCallHop("call-b"), answerHop("B's answer")];
    const boundB = bindTurnForTest({ runId: "run-b", agent: agentB });
    agentB.use(
      createProviderHopGuard(agentB, { readWriterContext: async () => boundB.turn.claim }),
    );
    setActiveRunHandle({ threadId: "thread-1", runId: "run-b", abort: () => {} });

    await kit.runAgent({ agent: agentB, runId: "run-b" });

    // B genuinely ran and answered -- otherwise the assertions below are vacuous.
    expect(agentB.hops).toHaveLength(2);
    const bAnswer = agentB.messages.filter((m) => m.role === "assistant").at(-1);
    expect(String((bAnswer as { content?: unknown })?.content)).toContain("B's answer");
    const bMessagesAfterSettle = agentB.messages.length;
    const bOwnedRuns = new Set(boundB.turn.ownedRunIds);

    // --- A resumes ---------------------------------------------------------
    releaseA?.();
    await runA;

    // A found it was no longer the bound turn.
    expect(aLateResultDelivered).toBe(true);
    expect(aResumedAuthorized).toBe(false);
    // A made no follow-up: one hop, the one it was authorised for.
    expect(agentA.hops).toHaveLength(1);
    // A's late tool result never reached B's conversation.
    expect(agentB.messages).toHaveLength(bMessagesAfterSettle);
    expect(
      agentB.messages.some((m) =>
        String((m as { content?: unknown }).content ?? "").includes("A's late tool result"),
      ),
    ).toBe(false);
    // A's subscriber saw only A's own runs -- never one of B's.
    expect(aSubscriberSaw.length).toBeGreaterThan(0);
    for (const runId of bOwnedRuns) expect(boundA.turn.ownedRunIds.has(runId)).toBe(false);

    // B's authority, ownership and Stop target are all intact.
    expect(readBoundTurn()).toBe(boundB.turn);
    expect(boundB.turn.refusal).toBeNull();
    expect(readActiveRunHandle()?.runId).toBe("run-b");
    // And A's cleanup cannot take B's Stop target away.
    clearActiveRunHandle("run-a");
    expect(readActiveRunHandle()?.runId).toBe("run-b");

    boundB.release();
  });

  it("clears the active run handle only for its own run", () => {
    // The other half of the same defect: A's late cleanup must not remove B's Stop
    // target, or a visibly running turn becomes uninterruptible.
    setActiveRunHandle({ threadId: "thread-b", runId: "run-b", abort: () => {} });

    clearActiveRunHandle("run-a");
    expect(readActiveRunHandle()?.runId).toBe("run-b");

    clearActiveRunHandle("run-b");
    expect(readActiveRunHandle()).toBeNull();
  });
});

describe("a failed run is not a completed one", () => {
  it("resolves rather than rejecting, and reports the failure through onRunFailed", async () => {
    // THE CONTRACT THAT CAUSED THE BUG, pinned against the real core: an agent-run
    // failure does NOT reject `runAgent`. A session relying on `catch` would therefore
    // record `completed` for a turn whose transport died. `onRunFailed` is the public
    // signal the session latches instead, so this asserts both halves.
    const kit = core();
    const agent = guarded([]);
    // Replace the script with a transport that errors.
    Object.defineProperty(agent, "run", {
      value: () =>
        new Observable<BaseEvent>((subscriber) => {
          subscriber.next({
            type: "RUN_STARTED",
            threadId: "thread-1",
            runId: "run-1",
          } as unknown as BaseEvent);
          subscriber.error(new Error("transport died"));
        }),
    });

    let failed = false;
    const subscription = agent.subscribe({
      onRunFailed: () => {
        failed = true;
      },
    });

    // Resolves. This is the assertion that documents why a `catch` is not enough.
    await expect(kit.runAgent({ agent, runId: "run-1" })).resolves.toBeDefined();
    subscription.unsubscribe();

    expect(failed).toBe(true);
    // And it is NOT an authority refusal -- the two must stay distinguishable, because
    // they are different things to tell a nurse.
    expect(bound.turn.refusal).toBeNull();
  });
});

describe("follow-ups stay bounded by CopilotKit's own limit", () => {
  it("stops a tool that keeps asking to be called again", async () => {
    // A runaway fixture: every hop calls the tool again. The app adds no recursion
    // protocol of its own, so this proves the library's bound is the one in force.
    const kit = core();
    let calls = 0;
    kit.addTool({
      name: TOOL,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        calls += 1;
        return "again";
      },
    });

    let nth = 0;
    const agent = guarded([], () =>
      toolCallHop(`call-${(nth += 1)}`)({
        threadId: "thread-1",
        runId: "run-1",
      } as RunAgentInput),
    );

    await kit.runAgent({ agent, runId: "run-1" });

    // It TERMINATED, which is the property under test: the app contributes no
    // recursion protocol, so a runaway tool is stopped by CopilotKit's own
    // `MAX_FOLLOW_UP_DEPTH` (observed at 100, and it logs when it trips). The ceiling
    // here is deliberately loose -- pinning their constant would make a library
    // upgrade fail this test for the wrong reason.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(200);
    expect(agent.hops.length).toBeLessThanOrEqual(200);
  });
});
