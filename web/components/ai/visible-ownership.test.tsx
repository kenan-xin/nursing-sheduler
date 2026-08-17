// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { z } from "zod";

// WHO OWNS WHAT THE USER IS LOOKING AT.
//
// Two places read disk and then publish what they read: hydration, and the reconcile
// that follows an interruption. Both have an await in the middle, and in that gap a
// newer turn can launch, mirror a tool result, answer and settle. Publishing then
// replaces the conversation the user is reading with an older snapshot of disk.
//
// The guard used to be "is the panel agent running?", which is wrong twice: the run
// happens on a per-turn CLONE so the panel agent is idle throughout, and by the time a
// slow read resolves the newer turn may have finished anyway -- at which point a
// bound-turn check reads null and a running check reads false, and both let the stale
// read through. So ownership is a monotonic revision, captured before the await and
// compared-and-claimed in the same synchronous step as the write.
//
// Every case here suspends A AFTER its disk read and BEFORE its publication, which is
// the only window in which the bug exists.

const AGENT_ID = "scheduler:thread";
const SCENARIO_ID = "scenario-a";
const TOOL_NAME = "get_schedule_overview";

/** Suspends `readThreadMessages` after the real read, before the caller publishes. */
const reads = vi.hoisted(() => ({
  /** Set to hold the NEXT read; resolved by the test to let it publish. */
  hold: null as null | (() => void),
  /** Resolves once a read is actually suspended. */
  arrived: null as null | (() => void),
  /** How many reads have been suspended. */
  suspended: 0,
  /** The same, for the scrub A performs while preparing its launch. */
  holdScrub: null as null | (() => void),
  scrubArrived: null as null | (() => void),
  /** Every scrub the repository has been asked for, held or not. */
  scrubCalls: 0,
  /** The one call that was suspended, by identity. */
  heldCall: null as null | { call: number; threadId: string },
}));

vi.mock("@/lib/ai/assistant/history-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/assistant/history-repo")>();
  return {
    ...actual,
    scrubThreadHistory: async (threadId: string) => {
      const call = (reads.scrubCalls += 1);
      const outcome = await actual.scrubThreadHistory(threadId);
      if (reads.holdScrub) {
        const release = reads.holdScrub;
        reads.holdScrub = null;
        // IDENTITY, NOT A COUNT. B and the remount legitimately scrub too, so a global
        // "exactly one scrub happened" guard is a statement about the whole test rather
        // than about A -- and under a mutated ordering it trips before the assertions
        // that matter ever run. This records WHICH call was held, so later scrubs are
        // free to happen and A's engagement stays a fact about A.
        reads.heldCall = { call, threadId };
        reads.scrubArrived?.();
        await new Promise<void>((resolve) => {
          gates.set(release, resolve);
        });
      }
      return outcome;
    },
    readThreadMessages: async (
      threadId: string,
      config?: Parameters<typeof actual.readThreadMessages>[1],
    ) => {
      const records = await actual.readThreadMessages(threadId, config);
      if (reads.hold) {
        const release = reads.hold;
        reads.hold = null;
        reads.suspended += 1;
        reads.arrived?.();
        await new Promise<void>((resolve) => {
          gates.set(release, resolve);
        });
      }
      return records;
    },
  };
});

/** Maps a test's release token to the resolver that frees the suspended read. */
const gates = new Map<() => void, () => void>();

import { useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant, useAssistantStore } from "@/lib/ai/assistant/store";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { readActiveRunHandle } from "@/lib/ai/assistant/runtime-stop";
import { boundTurnGeneration, readBoundTurn } from "./turn-authority";
import { useInterruptionWatch } from "./use-interruption-watch";
import { useAssistantSession, type AssistantSession } from "./use-assistant-session";
import { LifecycleNotice, RefusalNotice } from "./assistant-conversation";

const BASE_WRITER: WriterContext = {
  scenarioId: SCENARIO_ID,
  documentRevision: 12,
  leaseEpoch: 4,
  scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01", rangeEnd: "2026-09-30" },
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

let writerContext: WriterContext | null = BASE_WRITER;

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

type Shape = "answer" | "toolThenAnswer" | "toolThenSilentFollowUp";

class ScriptedAgent extends AbstractAgent {
  shape: Shape = "answer";
  answer = "an answer";
  readonly clones: ScriptedAgent[] = [];
  private hop = 0;

  constructor() {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const nth = (this.hop += 1);
    const callId = `${input.runId}-call`;
    const shape = this.shape;
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: unknown) => subscriber.next(event as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      if (shape !== "answer" && nth === 1) {
        emit({
          type: "TOOL_CALL_START",
          parentMessageId: `msg-${callId}`,
          toolCallId: callId,
          toolCallName: TOOL_NAME,
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: "{}" });
        emit({ type: "TOOL_CALL_END", toolCallId: callId });
      } else if (shape === "toolThenSilentFollowUp" && nth === 2) {
        // No text boundary at all -- the case where nothing after the tool result
        // republishes, so a stale read has no later write to correct it.
      } else {
        const messageId = `${input.runId}-answer`;
        emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: this.answer });
        emit({ type: "TEXT_MESSAGE_END", messageId });
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
    copy.setMessages([...this.messages]);
    this.clones.push(copy);
    return copy;
  }
}

let harness: AssistantHarness;
let threadId: string;
let agent: ScriptedAgent;
const session: { current: AssistantSession | null } = { current: null };

function Host() {
  // The watch is what turns an authority-projection change -- a scenario switch, a
  // lease loss, a takeover -- into an interruption. It lives in `AssistantSurface` in
  // the app, so a Host without it would leave those three triggers inert.
  useInterruptionWatch();
  session.current = useAssistantSession({
    threadId,
    routePath: "/shift-requests",
    routeLabel: "Shifts",
    historical: false,
  });
  return (
    <>
      <RefusalNotice />
      <LifecycleNotice />
      <div data-testid="transcript">
        {session.current.messages.map((message) => (
          <p key={message.id} data-role={message.role}>
            {typeof message.content === "string" ? message.content : ""}
          </p>
        ))}
      </div>
    </>
  );
}

beforeEach(async () => {
  harness = await createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();
  reads.hold = null;
  reads.arrived = null;
  reads.suspended = 0;
  reads.holdScrub = null;
  reads.scrubArrived = null;
  reads.scrubCalls = 0;
  reads.heldCall = null;
  gates.clear();
  writerContext = BASE_WRITER;

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
  for (const resolve of gates.values()) resolve();
  cleanup();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Arm the next `readThreadMessages` to suspend, and hand back its release. */
function holdNextRead() {
  const token = () => {};
  const reached = new Promise<void>((resolve) => {
    reads.arrived = resolve;
  });
  reads.hold = token;
  return {
    reached,
    release: () => gates.get(token)?.(),
  };
}

/** Re-activate the sentinel configuration, the way the setup flow does. */
async function activateSentinel() {
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
}

/**
 * Start A and suspend it inside the REAL scrub, the last await before its launch claim.
 *
 * A turn paused here holds a durable `preparing` row and nothing else, which is what
 * makes it the dangerous one: everything it would go on to take -- the run handle, the
 * binding, the lifecycle -- belongs to whichever turn replaces it.
 */
async function suspendAtScrub() {
  agent.shape = "toolThenAnswer";
  agent.answer = "A's answer";

  const token = () => {};
  const reached = new Promise<void>((resolve) => {
    reads.scrubArrived = resolve;
  });
  reads.holdScrub = token;

  let sent!: Promise<void>;
  act(() => {
    sent = session.current!.send("first question");
  });
  await reached;
  // A's OWN scrub is the one suspended: this thread, and exactly one call held.
  expect(reads.heldCall).not.toBeNull();
  expect(reads.heldCall!.threadId).toBe(threadId);
  const heldCall = reads.heldCall!.call;

  return {
    sent,
    heldCall,
    release: () => gates.get(token)?.(),
  };
}

/** B's visible facts plus the authority state a resuming A could steal. */
function snapshotWithAuthority() {
  return {
    ...snapshotB(),
    handle: JSON.stringify(readActiveRunHandle()?.runId ?? null),
    bound: JSON.stringify(readBoundTurn()?.token.turnId ?? null),
    launches: boundTurnGeneration(),
  };
}

/** Everything about B that a stale publication would disturb. */
function snapshotB() {
  const state = useAssistantStore.getState();
  return {
    messages: JSON.stringify((realAgent.current as ScriptedAgent).messages),
    dom: document.body.innerHTML,
    refusal: JSON.stringify(state.lastRefusal),
    settlement: JSON.stringify(state.lastSettlement),
    running: session.current!.isRunning,
  };
}

/** Run A, stop it, and suspend the reconcile read it triggers. */
async function stopAWithHeldReconcile(shape: Shape) {
  agent.shape = shape;
  agent.answer = "A's answer";

  await act(async () => {
    await session.current!.send("first question");
  });
  // Armed AFTER the send: `prepareSend` reads the thread too, and holding that one
  // would suspend the very turn this case needs to have finished.
  const held = holdNextRead();
  act(() => {
    session.current!.stop();
  });
  await held.reached;
  expect(reads.suspended).toBeGreaterThan(0);
  return held;
}

/** Let B run to completion on the same logical thread. */
async function runB(shape: Shape) {
  await waitFor(() => expect(session.current!.interrupting).toBe(false));
  agent.shape = shape;
  agent.answer = "B's answer";
  await act(async () => {
    await session.current!.send("second question");
  });
  await settle();
}

describe("a disk read that resolves after a newer turn has taken the panel", () => {
  it.each(["toolThenAnswer", "toolThenSilentFollowUp"] as const)(
    "publishes nothing when B ran as %s",
    async (shape) => {
      const held = await stopAWithHeldReconcile("toolThenAnswer");
      await runB(shape);

      // B has COMPLETED and its turn is unbound. A `readBoundTurn() === null` guard
      // would read "nothing owns this" here and let the stale read through.
      expect(session.current!.isRunning).toBe(false);
      const before = snapshotB();
      // Non-vacuity: B really did publish something. The silent shape emits no text
      // boundary at all, so what it leaves behind is the completed tool pair -- and
      // that is precisely the case with no later write to repair a stale overwrite.
      expect(before.messages).toContain(
        shape === "toolThenSilentFollowUp" ? "the tool result" : "B's answer",
      );

      held.release();
      await settle();
      await settle();

      expect(snapshotB()).toEqual(before);
    },
  );

  it("leaves B's durable history untouched as well", async () => {
    const held = await stopAWithHeldReconcile("toolThenAnswer");
    await runB("toolThenAnswer");

    const durableBefore = JSON.stringify(await harness.db.assistantMessages.toArray());
    held.release();
    await settle();

    expect(JSON.stringify(await harness.db.assistantMessages.toArray())).toBe(durableBefore);
  });

  it("no-ops when the hook that started it has been unmounted and replaced", async () => {
    // A remount is one of the ways a newer turn takes the list over, and the old
    // effect's continuation outlives its own hook instance.
    const held = await stopAWithHeldReconcile("toolThenAnswer");

    cleanup();
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());
    await runB("toolThenAnswer");

    const before = snapshotB();
    expect(before.messages).toContain("B's answer");

    held.release();
    await settle();
    await settle();

    expect(snapshotB()).toEqual(before);
  });
});

describe("a prepared turn suspended at the real scrub boundary", () => {
  // The scrub is the last await before the launch claim. A turn suspended there has a
  // durable `preparing` row and nothing else -- no handle, no binding, no UI. When it
  // resumes past a Stop and a remount, everything it would otherwise take belongs to
  // the turn that replaced it.

  /**
   * The complete named set, each driven the way the product drives it.
   *
   * `recover` is the legitimate path a user would take before they could send again,
   * and it is part of the case rather than setup: a B that was silently refused is not
   * a replacement, so every case has to reach a B that actually runs.
   */
  const CASES = [
    {
      label: "Stop",
      apply: async () => {
        await assistantActions.interrupt({ trigger: "stop", threadId, scenarioId: SCENARIO_ID });
      },
      immediate: () => expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("stop"),
      recover: async () => {},
    },
    {
      label: "Disable",
      apply: async () => {
        await assistantActions.setEnabled(false, { threadId, scenarioId: SCENARIO_ID });
      },
      // The whole surface is gone: not ready, so no launcher and no send.
      immediate: () => expect(useAssistantStore.getState().settings.enabled).toBe(false),
      recover: async () => {
        await assistantActions.setEnabled(true);
        await activateSentinel();
      },
    },
    {
      label: "Clear all",
      apply: async () => {
        await assistantActions.clearAll({ threadId, scenarioId: SCENARIO_ID });
      },
      // The credential row is gone with the conversation.
      immediate: () => expect(useAssistantStore.getState().settings.apiKey).toBeNull(),
      recover: async () => {
        await assistantActions.setEnabled(true);
        await activateSentinel();
        threadId = (await selectActiveThread(SCENARIO_ID)).threadId;
      },
    },
    {
      label: "Clear history",
      apply: async () => {
        await assistantActions.clearHistory({ threadId, scenarioId: SCENARIO_ID });
      },
      immediate: () =>
        expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("clear_history"),
      recover: async () => {
        threadId = (await selectActiveThread(SCENARIO_ID)).threadId;
      },
    },
    {
      label: "Remove key",
      apply: async () => {
        await assistantActions.removeKey({ threadId, scenarioId: SCENARIO_ID });
      },
      immediate: () => expect(useAssistantStore.getState().settings.apiKey).toBeNull(),
      recover: async () => {
        await activateSentinel();
      },
    },
    {
      label: "Replace configuration",
      apply: async () => {
        await assistantActions.activate(
          { apiKey: "sk-or-REPLACEMENT-0002", modelId: "vendor/other", modelSource: "custom" },
          { threadId, scenarioId: SCENARIO_ID },
        );
      },
      immediate: () => expect(useAssistantStore.getState().settings.modelId).toBe("vendor/other"),
      recover: async () => {},
    },
    {
      label: "Scenario change",
      apply: async () => {
        writerContext = { ...BASE_WRITER, scenarioId: "scenario-b" };
        act(() => {
          useAuthorityStore.setState({ scenarioId: "scenario-b" });
        });
        await waitFor(() =>
          expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("scenario_switch"),
        );
      },
      immediate: () => expect(useAuthorityStore.getState().scenarioId).toBe("scenario-b"),
      recover: async () => {
        // The user comes back to the document the panel is bound to.
        writerContext = BASE_WRITER;
        act(() => {
          useAuthorityStore.setState({ scenarioId: SCENARIO_ID });
        });
      },
    },
    {
      label: "Lease loss",
      apply: async () => {
        writerContext = null;
        act(() => {
          useAuthorityStore.setState({ ownership: "expired" });
        });
        await waitFor(() =>
          expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("lease_lost"),
        );
      },
      immediate: () => expect(useAuthorityStore.getState().ownership).toBe("expired"),
      recover: async () => {
        writerContext = BASE_WRITER;
        act(() => {
          useAuthorityStore.setState({ ownership: "owner" });
        });
      },
    },
    {
      label: "Takeover",
      apply: async () => {
        writerContext = null;
        act(() => {
          useAuthorityStore.setState({ ownership: "taken-over" });
        });
        await waitFor(() =>
          expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("takeover"),
        );
      },
      immediate: () => expect(useAuthorityStore.getState().ownership).toBe("taken-over"),
      recover: async () => {
        // This tab takes the lease back, which is the only way it may write again.
        writerContext = BASE_WRITER;
        act(() => {
          useAuthorityStore.setState({ ownership: "owner" });
        });
      },
    },
    {
      label: "Lease epoch change",
      // NOT an interruption. A peer advancing the lease disturbs no turn row and moves
      // no turn epoch, so nothing settles -- A is refused at its own launch claim, by
      // the durable writer comparison. Kept as its own case precisely because that is a
      // different mechanism from the eight above.
      apply: async () => {
        writerContext = { ...BASE_WRITER, leaseEpoch: BASE_WRITER.leaseEpoch + 1 };
      },
      immediate: () => expect(useAssistantStore.getState().settings.enabled).toBe(true),
      recover: async () => {},
    },
    {
      label: "Document revision change",
      // Also not an interruption, and for the same reason: an ordinary same-tab commit
      // moves the revision without disturbing the turn. A is refused at the final
      // identity comparison; B prepares fresh against the new revision and proceeds.
      apply: async () => {
        writerContext = { ...BASE_WRITER, documentRevision: 13 };
        act(() => {
          useAuthorityStore.setState({ documentRevision: 13 });
        });
      },
      immediate: () => expect(useAuthorityStore.getState().documentRevision).toBe(13),
      recover: async () => {},
    },
  ] as const;

  // A TURN-EPOCH MOVE IS NOT A SEPARATE CASE, and that is a finding rather than an
  // omission. The epoch is moved by `closeGate`, which only the interruption controller
  // calls -- so every one of the eight interruption cases above IS an epoch move, and
  // there is no product control that moves it alone. Counting it separately would be
  // counting one of those cases twice under a second name.
  it("has no product path that moves the turn epoch without an interruption", () => {
    const before = useAssistantStore.getState().turnEpoch;
    // Nothing in the public action surface moves it on its own.
    assistantActions.openPanel();
    assistantActions.closePanel();
    assistantActions.clearDiagnostic();
    expect(useAssistantStore.getState().turnEpoch).toBe(before);
  });

  it.each(CASES.map((entry) => [entry.label, entry] as const))(
    "takes nothing from B after %s",
    async (_label, entry) => {
      const held = await suspendAtScrub();

      // A holds a durable preparing row and nothing more.
      expect(readActiveRunHandle()).toBeNull();
      expect(readBoundTurn()).toBeNull();
      const clonesAtPause = agent.clones.length;

      await entry.apply();
      entry.immediate();

      await entry.recover();
      await waitFor(() => expect(session.current!.interrupting).toBe(false));

      // The panel closes and reopens, then B runs on the new instance.
      cleanup();
      render(<Host />);
      await waitFor(() => expect(session.current).not.toBeNull());
      const clonesBeforeB = agent.clones.length;
      agent.shape = "toolThenAnswer";
      agent.answer = "B's answer";
      await act(async () => {
        await session.current!.send("second question");
      });
      await settle();

      // B ACTUALLY RAN. A B that was silently refused is not a replacement, so this is
      // the assertion that stops the whole case from being vacuous.
      expect(agent.clones.length).toBeGreaterThan(clonesBeforeB);
      const before = snapshotWithAuthority();
      expect(before.messages).toContain("B's answer");
      const durableBefore = JSON.stringify(await harness.db.assistantMessages.toArray());
      const clonesAfterB = agent.clones.length;

      held.release();
      await settle();
      await settle();

      // A minted no clone at all -- so no core invocation and no provider bytes -- and
      // every one of B's facts is exactly as it was.
      expect(agent.clones.length).toBe(clonesAfterB);
      expect(clonesAfterB).toBeGreaterThan(clonesAtPause);
      expect(snapshotWithAuthority()).toEqual(before);
      expect(JSON.stringify(await harness.db.assistantMessages.toArray())).toBe(durableBefore);
    },
  );

  it("takes nothing from a B that launched, ran and settled across a remount", async () => {
    agent.shape = "toolThenAnswer";
    agent.answer = "A's answer";

    const token = () => {};
    const reached = new Promise<void>((resolve) => {
      reads.scrubArrived = resolve;
    });
    reads.holdScrub = token;

    let sentA!: Promise<void>;
    act(() => {
      sentA = session.current!.send("first question");
    });
    await reached;
    // The pause really engaged, at the real scrub, for this thread.
    expect(reads.heldCall?.threadId).toBe(threadId);

    // A holds a durable preparing row and nothing more: no run has been published.
    expect(readActiveRunHandle()).toBeNull();
    expect(readBoundTurn()).toBeNull();

    act(() => {
      session.current!.stop();
    });

    // The panel closes and reopens, then B runs to completion on the new instance.
    cleanup();
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());
    const clonesBeforeB = agent.clones.length;
    await runB("toolThenAnswer");

    // B ACTUALLY CALLED THE CORE -- otherwise "B is unchanged" would be a claim about
    // nothing.
    expect(agent.clones.length).toBeGreaterThan(clonesBeforeB);
    const before = {
      ...snapshotB(),
      handle: JSON.stringify(readActiveRunHandle()?.runId ?? null),
      bound: JSON.stringify(readBoundTurn()?.token.turnId ?? null),
    };
    expect(before.messages).toContain("B's answer");
    const durableBefore = JSON.stringify(await harness.db.assistantMessages.toArray());
    const clonesAfterB = agent.clones.length;

    // A resumes.
    gates.get(token)?.();
    await act(async () => {
      await sentA;
    });
    await settle();

    // A published nothing and sent nothing: no new clone, so no core invocation and no
    // provider bytes; and every one of B's facts is exactly as it was.
    expect(agent.clones.length).toBe(clonesAfterB);
    expect({
      ...snapshotB(),
      handle: JSON.stringify(readActiveRunHandle()?.runId ?? null),
      bound: JSON.stringify(readBoundTurn()?.token.turnId ?? null),
    }).toEqual(before);
    expect(JSON.stringify(await harness.db.assistantMessages.toArray())).toBe(durableBefore);
  });
});

describe("two reads captured at the same revision", () => {
  it("lets exactly one of them publish", async () => {
    // Both capture the same revision, so a bare comparison would pass for both. The
    // first publication advances the revision as it writes -- compare and claim are one
    // step -- which is what makes the second refuse.
    const { claimVisibleWrite, readVisibleRevision } = await import("./turn-authority");

    const target = { messages: [] as unknown[], writes: 0 };
    const publish = (owned: number, messages: unknown[]) => {
      if (readVisibleRevision() !== owned) return false;
      target.messages = messages;
      target.writes += 1;
      claimVisibleWrite();
      return true;
    };

    const owned = readVisibleRevision();
    expect(publish(owned, ["first"])).toBe(true);
    expect(publish(owned, ["second"])).toBe(false);
    expect(target.writes).toBe(1);
    expect(target.messages).toEqual(["first"]);
  });
});
