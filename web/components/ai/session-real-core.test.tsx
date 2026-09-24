// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitProvider,
  useCopilotKit,
  type CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";

import { useAuthorityStore } from "@/lib/store";
import {
  assistantActions,
  hydrateAssistant,
  turnAwaitsUserOnCard,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
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
import { readThreadMessages } from "@/lib/ai/assistant/history-repo";
import { readBoundTurn } from "./turn-authority";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "./model-visible-tools";
import { z } from "zod";
import { useAssistantSession, type AssistantSession } from "./use-assistant-session";
import { LifecycleNotice, RefusalNotice } from "./assistant-conversation";

// THE INTEGRATION SEAM ITSELF, under the locked library.
//
// The failure contract was previously proved in two halves: one suite showed the real
// core resolves a transport error and reports it via `onRunFailed`; another showed the
// shipped session turns a failure into `run_failed`. Neither could catch a MISWIRED
// SEAM -- a subscriber attached to the wrong instance, a callback that never fires, a
// filter that rejects its own run. That wiring is the thing most likely to be wrong,
// so this suite drives it directly.
//
// What is real here: a real `CopilotKitProvider` and the `CopilotKitCore` it builds, the
// shipped `useAssistantSession`, the real `useCopilotKit` and `useFrontendTool`, a real
// `AbstractAgent`, the real store, the real Dexie turn rows, the real settlement
// precedence.
//
// ONLY `useAgent` IS SEAMED, because the agent's transport must be a scripted observable:
// the whole point of several cases below is a provider that fails, and a real one cannot
// be dialled from a unit environment.
//
// WHY THE PROVIDER MATTERS AND NOT JUST THE CORE. `useFrontendTool` was previously stubbed
// to a no-op here, so the session mounted no tools at all and this suite could say nothing
// about the model-visible surface. A separate fixture mounted the registration root
// DIRECTLY and enumerated a core it had constructed itself -- which proves the root
// registers tools, but not that the shipped session mounts that root. Rendering the real
// session under a real provider closes that gap: the registry enumerated below is the one
// the production path actually produced.

const AGENT_ID = "scheduler:thread";
const SCENARIO_ID = "scenario-a";
/**
 * The name the SCRIPTED transport calls, and the name this suite registers by hand.
 *
 * Deliberately NOT a shipped tool name. It used to be `get_schedule_overview`, which was
 * harmless only while `useFrontendTool` was stubbed and the session registered nothing.
 * Under a real provider that name collides with the session's own registration --
 * CopilotKit resolves `{ toolName, agentId }` and the later mount wins -- so a fixture
 * borrowing a live name would be overridden mid-test by the real handler.
 */
const TOOL_NAME = "test_only_suspending_tool";

const BASE_WRITER: WriterContext = {
  scenarioId: SCENARIO_ID,
  documentRevision: 12,
  leaseEpoch: 4,
  scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01", rangeEnd: "2026-09-30" },
};
let writerContext: WriterContext | null = BASE_WRITER;
/** A lease that has moved on -- what a takeover in another tab looks like here. */
const revokedWriter: WriterContext = { ...BASE_WRITER, leaseEpoch: BASE_WRITER.leaseEpoch + 1 };
let revokeFromHopOnward = false;

vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Same allowance as the send-authority suite: the lease/envelope read has its own
// tests, and faking it lets a case revoke ownership at an exact moment.
vi.mock("@/lib/ai/assistant/writer-context", async () => {
  const { readActiveRunHandle } = await import("@/lib/ai/assistant/runtime-stop");
  return {
    readWriterContext: async () => {
      // Revoking BEFORE the send would just fail the gate -- the plan would be built
      // from the moved lease and everything would agree. The window that matters is
      // AFTER the launch claim and BEFORE the transport, and the active run handle is
      // exactly the marker for it: the session publishes it immediately after the
      // final identity check, and the hop guard's own reread comes next.
      if (revokeFromHopOnward && readActiveRunHandle() !== null) return revokedWriter;
      return writerContext;
    },
  };
});

const realAgent = vi.hoisted(() => ({ current: null as unknown }));
const realCore = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@copilotkit/react-core/v2", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // THE ONLY SEAM. Everything else -- provider, core, `useCopilotKit`,
    // `useFrontendTool` -- is the library's own.
    useAgent: () => ({ agent: realAgent.current, isReady: true }),
  };
});

/**
 * How this agent's transport behaves for one hop.
 *
 * `"fail"` errors the observable, which is exactly what a dead provider produces and
 * what the locked core swallows into an empty resolve.
 */
type Behaviour = "fail" | "succeed";

class ScriptedTransportAgent extends AbstractAgent {
  behaviour: Behaviour = "fail";
  /** Every run id the transport actually saw. */
  readonly runIds: string[] = [];
  /** Every run input this INSTANCE saw, so a test can read the provider history. */
  readonly hopInputs: RunAgentInput[] = [];
  /**
   * When set, hop 1 of each clone calls the tool and hop 2 answers -- the shape a
   * real tool-using turn has, and the one the overlap acceptance needs.
   */
  toolLoop = false;
  /** What hop 1 of a tool loop calls. A shipped name drives the session's real handler. */
  toolCall = { name: TOOL_NAME, args: "{}" };
  /**
   * Emit `RUN_FINISHED` with no assistant text -- the shape the live turn produced.
   *
   * A SUCCEEDING TRANSPORT USED TO MEAN THIS, and that was the defect: the suite's
   * positive case asserted a turn which reached the provider, said nothing, and was
   * recorded `completed` with no notice on screen. The positive case now emits real
   * text; this flag is how the silent shape is still reachable, as a failure case.
   */
  silentSuccess = false;
  /**
   * What the assistant message finally contains, when one is emitted at all.
   *
   * AG-UI ACCEPTS AN EMPTY PAIR. `TEXT_MESSAGE_START` -> `TEXT_MESSAGE_END` with no
   * content in between is a well-formed message, and the locked contract reports its
   * `textMessageBuffer` as `""`. So "a boundary arrived" and "the user got a reply" are
   * different facts, and this is how the suite drives the gap between them.
   */
  answerBody: string | null = null;
  private hop = 0;
  /**
   * When set, the transport reports a run failure under THIS run id -- one this turn
   * never owned -- straight to its own subscribers, then finishes normally.
   *
   * Delivered from inside the run, because the session subscribes to the per-turn
   * CLONE: a subscriber attached to the parent from a test would never be called, and
   * a test that sabotaged the parent would pass while proving nothing.
   */
  foreignFailureRunId: string | null = null;
  /** How many times a foreign failure was actually handed to a subscriber. */
  foreignFailuresDelivered = 0;
  /** Every clone this agent produced, in order. One per top-level turn. */
  readonly clones: ScriptedTransportAgent[] = [];

  constructor() {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runIds.push(input.runId);
    this.hopInputs.push(input);
    if (this.toolLoop) return this.runToolLoopHop(input);
    const behaviour = this.behaviour;
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as unknown as BaseEvent);
      if (behaviour === "fail") {
        subscriber.error(new Error("transport died"));
        return;
      }
      if (this.foreignFailureRunId !== null) {
        const foreign = { ...input, runId: this.foreignFailureRunId };
        for (const listener of this.subscribers) {
          if (!listener.onRunFailed) continue;
          this.foreignFailuresDelivered += 1;
          listener.onRunFailed({
            error: new Error("someone else's failure"),
            input: foreign,
            messages: this.messages,
            state: this.state,
            agent: this,
          });
        }
      }
      if (this.silentSuccess) {
        // THE LIVE DEFECT'S SHAPE, kept deliberately: reached the provider, came back
        // with nothing. It used to settle `completed`; it is now a bounded failure.
        subscriber.next({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as unknown as BaseEvent);
        subscriber.complete();
        return;
      }
      const messageId = `${input.runId}-answer`;
      subscriber.next({
        type: "TEXT_MESSAGE_START",
        messageId,
        role: "assistant",
      } as unknown as BaseEvent);
      // `answerBody: ""` emits NO content event at all -- the empty pair AG-UI accepts.
      const body = this.answerBody ?? this.answer;
      if (body.length > 0) {
        subscriber.next({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: body,
        } as unknown as BaseEvent);
      }
      subscriber.next({ type: "TEXT_MESSAGE_END", messageId } as unknown as BaseEvent);
      subscriber.next({
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      } as unknown as BaseEvent);
      subscriber.complete();
    });
  }

  /** Hop 1 asks for the tool; hop 2 answers. Per clone, so each turn gets both. */
  private runToolLoopHop(input: RunAgentInput): Observable<BaseEvent> {
    const nth = (this.hop += 1);
    const callId = `${input.runId}-call`;
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as unknown as BaseEvent);
      if (nth === 1) {
        subscriber.next({
          type: "TOOL_CALL_START",
          parentMessageId: `msg-${callId}`,
          toolCallId: callId,
          toolCallName: this.toolCall.name,
        } as unknown as BaseEvent);
        subscriber.next({
          type: "TOOL_CALL_ARGS",
          toolCallId: callId,
          delta: this.toolCall.args,
        } as unknown as BaseEvent);
        subscriber.next({ type: "TOOL_CALL_END", toolCallId: callId } as unknown as BaseEvent);
      } else {
        const messageId = `${input.runId}-answer`;
        subscriber.next({
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant",
        } as unknown as BaseEvent);
        // Same `answerBody` rule as the direct shape: `""` emits no content event, so
        // the follow-up hop closes an empty message after a real tool result.
        const body = this.answerBody ?? this.answer;
        if (body.length > 0) {
          subscriber.next({
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: body,
          } as unknown as BaseEvent);
        }
        subscriber.next({ type: "TEXT_MESSAGE_END", messageId } as unknown as BaseEvent);
      }
      subscriber.next({
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      } as unknown as BaseEvent);
      subscriber.complete();
    });
  }

  /** What hop 2 says. Set per turn so A's and B's answers are distinguishable. */
  answer = "an answer";

  override clone(): ScriptedTransportAgent {
    const copy = new ScriptedTransportAgent();
    copy.behaviour = this.behaviour;
    copy.foreignFailureRunId = this.foreignFailureRunId;
    copy.toolLoop = this.toolLoop;
    copy.toolCall = this.toolCall;
    copy.silentSuccess = this.silentSuccess;
    copy.answer = this.answer;
    copy.answerBody = this.answerBody;
    copy.threadId = this.threadId;
    copy.agentId = this.agentId;
    // The parent keeps a handle on every clone it produced, so a test can inspect the
    // instance a turn actually ran on.
    this.clones.push(copy);
    // Shared so a test can read what the turn's own instance did.
    Object.defineProperty(copy, "foreignFailuresDelivered", {
      get: () => this.foreignFailuresDelivered,
      set: (value: number) => {
        this.foreignFailuresDelivered = value;
      },
    });
    copy.setMessages([...this.messages]);
    // The clone shares the parent's run log, so a test can see what the turn's own
    // dedicated instance actually sent without reaching for it.
    Object.defineProperty(copy, "runIds", { value: this.runIds });
    return copy;
  }
}

let harness: AssistantHarness;
let threadId: string;
let agent: ScriptedTransportAgent;
const session: { current: AssistantSession | null } = { current: null };

/**
 * The REAL notice surface, not a store read.
 *
 * `AssistantLiveConversation` is the shipped component that renders the refusal, the
 * interruption phase and the settlement notice. Mounting it is the only way to prove
 * a late turn publishes nothing a user would see; asserting store fields proves only
 * that the fields did not move, which is a weaker claim about a different thing.
 */
function Notices() {
  // The SHIPPED components, not copies: these are the two the live panel renders for
  // refusals and lifecycle/settlement. The transcript view is left out because it
  // pulls in `CopilotChatMessageView`, which needs a real provider -- and it is not
  // what this proof is about. What a late turn could wrongly publish renders here.
  return (
    <>
      <RefusalNotice />
      <LifecycleNotice />
    </>
  );
}

function Session() {
  session.current = useAssistantSession({
    threadId,
    routePath: "/shift-requests",
    routeLabel: "Requests",
    historical: false,
  });
  // The provider's OWN core, through the library's own hook -- not one this suite built.
  // Whatever the session registered while rendering is on it.
  realCore.current = useCopilotKit().copilotkit;
  // The real notice surface renders alongside, so the DOM assertions below are about
  // what a user would actually see rather than about store fields.
  return <Notices />;
}

/** The shipped session under a real provider. This is the production path. */
function Host() {
  return (
    <CopilotKitProvider agents__unsafe_dev_only={{ [AGENT_ID]: agent }}>
      <Session />
    </CopilotKitProvider>
  );
}

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();
  writerContext = BASE_WRITER;
  revokeFromHopOnward = false;

  agent = new ScriptedTransportAgent();
  realAgent.current = agent;
  // The core is the PROVIDER'S, captured in `Session` below. Constructing one here is
  // what let the old fixture enumerate a registry the shipped session never touched.
  realCore.current = null;

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
  cleanup();
  vi.restoreAllMocks();
});

async function send(text = "why is the 15th short?") {
  await act(async () => {
    await session.current!.send(text);
  });
}

/** The turn row this send produced. */
async function lastTurn() {
  const turns = await harness.db.assistantTurns.toArray();
  return turns.at(-1);
}

/**
 * The transport was genuinely reached, on this turn's OWN run, and nothing refused it.
 *
 * Every silence case asserts this before it asserts an outcome, so a `run_failed` here
 * can never be a guard refusal, a foreign run, an abort, or a harness that never dialled
 * the provider. These anchors are independent of the buffer rule under test, so a
 * mutation of that rule must not be able to satisfy or trip them.
 */
function expectOneOwnedHop() {
  const ran = agent.clones.at(-1) ?? agent;
  expect(ran.hopInputs).toHaveLength(1);
  expect(ran.runIds).toEqual([ran.hopInputs[0].runId]);
  expect(useAssistantStore.getState().lastRefusal).toBeNull();
}

/**
 * Drive a real tool loop: hop 1 calls the tool, the handler returns a real result, hop 2
 * closes an assistant message whose body is `answerBody`.
 *
 * The tool is registered on the REAL core rather than through `useFrontendTool` (which
 * this suite stubs), so CopilotKit's own loop drives the follow-up hop.
 */
async function sendToolLoop(body: string) {
  agent.toolLoop = true;
  agent.answerBody = body;

  const core = realCore.current as CopilotKitCore;
  let toolCalls = 0;
  core.addTool({
    name: TOOL_NAME,
    description: "Read the schedule.",
    agentId: AGENT_ID,
    parameters: z.object({}),
    handler: async () => {
      toolCalls += 1;
      return "the 15th has two RNs rostered";
    },
  });

  await send();

  // ANCHORS. Both hops reached the transport under this turn's own runs, and the tool
  // genuinely executed -- so the follow-up really was a post-result answer.
  const ran = agent.clones.at(-1) ?? agent;
  await waitFor(() => expect(ran.hopInputs.length).toBe(2));
  expect(toolCalls).toBe(1);
  expect(ran.runIds).toEqual(ran.hopInputs.map((hop) => hop.runId));
  expect(useAssistantStore.getState().lastRefusal).toBeNull();
}

/**
 * Hop 1 calls a SHIPPED tool, so the session's own handler runs; hop 2 says nothing.
 *
 * The session mounts its tools on `scheduler:<thread>`, so the agent must carry that id
 * for CopilotKit to resolve the call at all.
 */
function callShippedToolThenFallSilent(toolCall: { name: string; args: string }) {
  agent.agentId = `scheduler:${threadId}`;
  agent.toolLoop = true;
  agent.answerBody = "";
  agent.toolCall = toolCall;
}

/**
 * What the user actually sees when a turn is bounded-failed.
 *
 * THE SHIPPED COMPONENT AS THE HOST ALREADY RENDERS IT. `Host` mounts exactly one
 * `<LifecycleNotice />` from `./assistant-conversation`; the length check pins that this
 * is that component's own output rather than a second copy a test mounted to make the
 * query succeed. The forbidden list keeps the notice bounded: a user is told to retry,
 * never handed schema, provider, prompt or credential detail.
 */
async function expectBoundedFailureNotice() {
  const notices = await screen.findAllByTestId("assistant-settlement");
  expect(notices).toHaveLength(1);
  const [notice] = notices;
  expect(notice).toHaveAttribute("data-settlement", "run_failed");
  const text = notice.textContent ?? "";
  expect(text).toContain("could not be completed");
  expect(text).toContain("Send again to retry");
  for (const forbidden of [
    "Invalid JSON schema",
    "schema",
    "openrouter",
    "sk-or-",
    "api key",
    "prompt",
    "model",
    "why is the 15th short?",
  ]) {
    expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
}

describe("the model-visible surface the SHIPPED SESSION mounts", () => {
  // THE DECISIVE OWNERSHIP PROOF, and it runs through the production path: a real
  // `CopilotKitProvider`, the shipped `useAssistantSession`, the library's own
  // `useCopilotKit` and `useFrontendTool`. Nothing here mounts the registration root
  // directly, and nothing asks the core for a name it already expected.

  /**
   * Every tool on the provider's core, unfiltered.
   *
   * Read BEFORE any test-only `core.addTool` anywhere in this file, so a tool a later
   * case registers by hand can never be mistaken for one the session mounted.
   */
  function mountedTools(): readonly { name: string; agentId?: string; parameters?: unknown }[] {
    const core = realCore.current as CopilotKitCore | null;
    return (core?.tools ?? []) as readonly {
      name: string;
      agentId?: string;
      parameters?: unknown;
    }[];
  }

  it("is non-vacuous: rendering the session really populated the provider's registry", () => {
    // If this were ever empty, every assertion below would pass for the wrong reason --
    // which is exactly what a stubbed `useFrontendTool` used to do here.
    expect(realCore.current).not.toBeNull();
    expect(mountedTools().length).toBeGreaterThanOrEqual(8);
  });

  it("mounts exactly the canonical registry, as a multiset", () => {
    // A NINTH TOOL FAILS HERE whatever registered it, because the core resolved it and
    // this reads the core. No source analysis had to understand how it was written.
    expect(
      mountedTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      [...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS), ...PARAMETERLESS_MODEL_VISIBLE_TOOLS].sort(),
    );
  });

  it("mounts every tool on the EXACT canonical agent surface", () => {
    // THE EXACT IDENTITY, not merely one of them. Asserting that the set had size one
    // proved cardinality and nothing else: a reviewer changed the session's `localAgentId`
    // from `scheduler:<thread>` to `wrong-agent:<thread>` and this stayed green, because
    // every tool moved together and the set was still a singleton.
    const expected = `scheduler:${threadId}`;
    expect([...new Set(mountedTools().map((tool) => String(tool.agentId)))]).toEqual([expected]);
  });

  it("mounts no duplicate runtime identity", () => {
    // Kept as a floor, and honestly labelled: `core.tools` can only show a duplicate that
    // CopilotKit did not already discard. The registration-ATTEMPT invariant in
    // `register-model-visible-tool.ts` is what actually catches the collision -- see the
    // duplicate case in `register-model-visible-tool.test.tsx`.
    const keys = mountedTools().map((tool) => `${String(tool.agentId)}::${tool.name}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("mounts the EXACT canonical schema object for every parameterized tool", () => {
    // Identity, not shape. A registration declaring a look-alike schema -- or another
    // tool's schema -- passes a structural comparison and fails this.
    for (const [name, schema] of Object.entries(MODEL_VISIBLE_TOOL_SCHEMAS)) {
      const tool = mountedTools().find((entry) => entry.name === name);
      expect(tool, `${name} is not mounted by the shipped session`).toBeDefined();
      expect(tool!.parameters, `${name} mounts a different schema object`).toBe(schema);
    }
    for (const name of PARAMETERLESS_MODEL_VISIBLE_TOOLS) {
      const tool = mountedTools().find((entry) => entry.name === name);
      expect(tool, `${name} is not mounted by the shipped session`).toBeDefined();
      expect(tool!.parameters).toBeUndefined();
    }
  });
});

describe("the shipped session over the real core and a real failing agent", () => {
  it("records the locked contract: the core RESOLVES a transport failure", async () => {
    // The premise everything below rests on, asserted rather than assumed. If a future
    // version started rejecting instead, this test says so first and the session's
    // `catch` becomes reachable again.
    const core = realCore.current as CopilotKitCore;
    const probe = new ScriptedTransportAgent();

    await expect(core.runAgent({ agent: probe, runId: "probe-run" })).resolves.toBeDefined();
  });

  it("settles a real transport failure as run_failed, durably and in the UI", async () => {
    await send();

    // The transport really was reached -- otherwise this proves nothing.
    expect(agent.runIds.length).toBeGreaterThan(0);

    const turn = await lastTurn();
    expect(turn?.state).toBe("detached");
    expect(turn?.terminalReason).toBe("run_failed");

    const ui = useAssistantStore.getState();
    expect(ui.lastSettlement).toMatchObject({ settlement: "run_failed" });
    // A transport failure is nobody's interruption.
    expect(ui.lastSettlement?.trigger).toBeNull();
    // And it is not an authority refusal.
    expect(ui.lastRefusal).toBeNull();
  });

  it("is sensitive: the same path records completed when the transport succeeds", async () => {
    // Without this, the assertions above would pass just as well against a session
    // that marked every turn `run_failed`.
    agent.behaviour = "succeed";

    await send();

    // Its OWN transport hop, not merely a completed row: without this the case would
    // pass against a session that recorded success without sending anything.
    const ran = agent.clones.at(-1) ?? agent;
    expect(ran.hopInputs).toHaveLength(1);
    expect(ran.runIds).toEqual([ran.hopInputs[0].runId]);

    const turn = await lastTurn();
    expect(turn?.state).toBe("terminal");
    expect(turn?.terminalReason).toBe("completed");
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
  });

  it("settles a productive-looking but SILENT completion as a bounded failure", async () => {
    // THE LIVE DEFECT, reproduced through the real core and the shipped session: the
    // transport is reached, the run finishes, and nothing is said. It used to record
    // `completed` with a null settlement, so `LifecycleNotice` rendered nothing and the
    // user was left with only their own question.
    agent.behaviour = "succeed";
    agent.silentSuccess = true;

    await send();

    // ANCHORS, so this cannot be a guard refusal, a foreign run, an abort, or a harness
    // that never reached the provider.
    const ran = agent.clones.at(-1) ?? agent;
    expect(ran.hopInputs).toHaveLength(1);
    expect(ran.runIds).toEqual([ran.hopInputs[0].runId]);
    expect(useAssistantStore.getState().lastRefusal).toBeNull();

    const turn = await lastTurn();
    expect(turn?.state).toBe("detached");
    expect(turn?.terminalReason).toBe("run_failed");

    const ui = useAssistantStore.getState();
    expect(ui.lastSettlement).toMatchObject({ settlement: "run_failed" });
    // Not attributed to an interruption: nobody stopped this.
    expect(ui.lastSettlement?.trigger).toBeNull();
  });

  it("renders the bounded retry notice for that silent completion, with no detail", async () => {
    agent.behaviour = "succeed";
    agent.silentSuccess = true;

    await send();

    // THE SHIPPED COMPONENT AS THE HOST ALREADY RENDERS IT, not a second copy: the
    // defect was that nothing appeared on screen, so the assertion has to be about what
    // the user can actually see in the panel.
    const [notice] = await screen.findAllByTestId("assistant-settlement");
    expect(notice).toHaveAttribute("data-settlement", "run_failed");
    expect(notice.textContent ?? "").toContain("could not be completed");
    expect(notice.textContent ?? "").toContain("Send again to retry");
    // Bounded: no schema, provider, prompt or credential detail reaches the user.
    for (const forbidden of ["Invalid JSON schema", "type", "schema", "sk-or-", "openrouter"]) {
      expect(notice.textContent?.toLowerCase() ?? "").not.toContain(forbidden.toLowerCase());
    }
  });

  // THE TWO BOUNDARIES ARE ASSERTED SEPARATELY, ON PURPOSE.
  //
  // A single test that checked the durable row and then the notice would stop at the
  // first failure, so a mutation could never demonstrate that the DOM assertion is
  // itself load-bearing -- the durable assertion would always fire first and mask it.
  // Split, each boundary fails on its own under the unconditional-latch mutation, and
  // each is therefore independently proven.

  it.each([
    ["an EMPTY assistant message", ""],
    ["a WHITESPACE-ONLY assistant message", "   \n\t "],
  ])("settles %s as a bounded failure, durably", async (_label, body) => {
    // AG-UI accepts a START/END pair with no visible content, so this is a well-formed
    // message that says nothing. Counting the boundary alone let exactly this settle
    // `completed` -- the F1w silence, one layer down.
    agent.behaviour = "succeed";
    agent.answerBody = body;

    await send();
    expectOneOwnedHop();

    const turn = await lastTurn();
    expect(turn?.state).toBe("detached");
    expect(turn?.terminalReason).toBe("run_failed");
  });

  it.each([
    ["an EMPTY assistant message", ""],
    ["a WHITESPACE-ONLY assistant message", "   \n\t "],
  ])("puts the bounded retry notice on screen for %s", async (_label, body) => {
    // Deliberately asserts NOTHING about the durable row: the point of this test is that
    // the user is told, and it must be able to fail on that alone.
    agent.behaviour = "succeed";
    agent.answerBody = body;

    await send();
    expectOneOwnedHop();

    await expectBoundedFailureNotice();
  });

  it("is not vacuous: an ordinary text answer still completes", async () => {
    // The direct positive twin of the empty/whitespace pair above: same path, same
    // boundary, but the buffer carries something a nurse can read.
    agent.behaviour = "succeed";
    agent.answerBody = "the 15th is short because two RNs are on leave";

    await send();

    const ran = agent.clones.at(-1) ?? agent;
    expect(ran.hopInputs).toHaveLength(1);
    expect(ran.runIds).toEqual([ran.hopInputs[0].runId]);

    const turn = await lastTurn();
    expect(turn?.state).toBe("terminal");
    expect(turn?.terminalReason).toBe("completed");
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
    // And nothing is put in front of the user -- the DOM twin of the notice assertions.
    expect(screen.queryByTestId("assistant-settlement")).toBeNull();
  });

  it("settles a tool call, tool result and EMPTY follow-up as a bounded failure, durably", async () => {
    // THE SHAPE THE F1W FIX COULD NOT SEE. A tool ran and produced a real result, so the
    // turn looks productive from every angle except the one that matters: whether the
    // user was told anything. Work performed is not an answer, and this must settle
    // exactly like the direct empty message above.
    await sendToolLoop("");

    await waitFor(async () => {
      const turn = await lastTurn();
      expect(turn?.state).toBe("detached");
      expect(turn?.terminalReason).toBe("run_failed");
    });
  });

  it("puts the bounded retry notice on screen for a tool call, tool result and EMPTY follow-up", async () => {
    // The DOM half of the case above, standing alone. A turn that did real work and then
    // said nothing still owes the user a notice, and that obligation is proven here
    // without leaning on the durable assertion.
    await sendToolLoop("");

    await expectBoundedFailureNotice();
  });

  it("tool call, tool result and a real follow-up completes, silently", async () => {
    // The twin that keeps the pair above honest: identical loop, identical tool result,
    // and the only difference is that the follow-up buffer carries content.
    await sendToolLoop("here is why the 15th is short");

    await waitFor(async () => {
      const turn = await lastTurn();
      expect(turn?.state).toBe("terminal");
      expect(turn?.terminalReason).toBe("completed");
    });
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
    expect(screen.queryByTestId("assistant-settlement")).toBeNull();
  });

  it("a turn that ends on a shown option card completes with no notice, even with no text", async () => {
    // THE LIVE SHAPE (bead adb): the model asked via `offer_choices` and stopped, because
    // the answer is the user's next message. The card IS the reply; a retry notice beside
    // it told the user something failed when nothing had.
    callShippedToolThenFallSilent({
      name: "offer_choices",
      args: JSON.stringify({
        question: "Which borrowed nurse should go?",
        options: [
          { label: "Ana", detail: "" },
          { label: "Ben Tan", detail: "" },
        ],
        multiple: false,
      }),
    });

    await send("Please remove one of the borrowed nurses.");

    await waitFor(async () => {
      const turn = await lastTurn();
      expect(turn?.state).toBe("terminal");
      expect(turn?.terminalReason).toBe("completed");
    });
    expect(useAssistantStore.getState().activeChoices?.question).toBe(
      "Which borrowed nurse should go?",
    );
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
    expect(screen.queryByTestId("assistant-settlement")).toBeNull();
  });

  it("counts only THIS turn's waiting card, option or run", () => {
    expect(turnAwaitsUserOnCard(7)).toBe(false);
    assistantActions.showRunRequest(7);
    expect(turnAwaitsUserOnCard(7)).toBe(true);
    expect(turnAwaitsUserOnCard(8)).toBe(false);
    assistantActions.clearRunRequest();
    assistantActions.showChoices({ question: "q", options: [], multiple: false }, 6);
    expect(turnAwaitsUserOnCard(7)).toBe(false);
  });

  it("a waiting-card tool that showed NO card, then silence, is still a bounded failure", async () => {
    // The twin that keeps the rule about the card, not the tool name: with no dates or
    // staff, `request_optimize_run` refuses and shows nothing, so the user got nothing.
    callShippedToolThenFallSilent({ name: "request_optimize_run", args: "{}" });

    await send("make me a roster");

    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
    await expectBoundedFailureNotice();
  });

  it("ignores a failure reported under a run it does not own", async () => {
    // AG-UI hands every subscriber the concrete `input`. The session filters on
    // `input.runId`, so a failure belonging to an overlapping run must not settle this
    // turn. Delivered here through the REAL agent's own subscriber dispatch, under a
    // run id this turn never owned.
    agent.behaviour = "succeed";
    agent.foreignFailureRunId = "a-run-this-turn-never-owned";

    await send();

    // Non-vacuity: the foreign failure really was handed to the session's own
    // subscriber. Without this the test would pass just as well if nothing fired --
    // and the first version of it did exactly that, because the session subscribes to
    // its per-turn clone rather than to the panel's agent.
    expect(agent.foreignFailuresDelivered).toBeGreaterThan(0);

    const turn = await lastTurn();
    expect(turn?.terminalReason).toBe("completed");
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
  });

  it("real Stop detaches a suspended A, and B still completes both hops and answers", async () => {
    // THE PRODUCTION-SHAPED OVERLAP, end to end through the shipped session.
    //
    // A takes a tool call and its handler suspends. The user presses Stop -- the REAL
    // one, which aborts A's published run handle through the interruption controller.
    // B is then sent on the SAME logical agent and thread. B must complete BOTH hops,
    // consume its own tool result and answer; A must contribute nothing, durably or
    // visibly.
    //
    // This is what a shared core made impossible: one `_runAbortController` for the
    // whole core meant Stop's abort suppressed B's follow-up, so B could take a tool
    // call and then never answer.
    agent.toolLoop = true;
    agent.answer = "A's answer";

    let releaseA: (() => void) | undefined;
    const aSuspended = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let toolCalls = 0;
    let aResumed = false;

    const core = realCore.current as CopilotKitCore;
    core.addTool({
      name: TOOL_NAME,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        toolCalls += 1;
        if (toolCalls === 1) {
          await aSuspended;
          aResumed = true;
          return "A's superseded tool result";
        }
        return "B's tool result";
      },
    });

    // --- A launches and suspends in its tool -------------------------------
    const aSend = session.current!.send("why is the 15th short?");
    await waitFor(() => expect(toolCalls).toBe(1));
    const aHandle = readActiveRunHandle();
    expect(aHandle).not.toBeNull();

    // --- The REAL Stop -----------------------------------------------------
    await act(async () => {
      session.current!.stop();
      await waitFor(() => expect(useAssistantStore.getState().interruption).toBeNull());
    });

    // --- B is sent on the same logical agent/thread ------------------------
    //
    // Through a PANEL REMOUNT, because that is the only way this overlap is reachable
    // in the shipped app: a non-cooperative tool leaves A's top-level promise pending,
    // and the session's single-flight ref refuses a second send from the same mount.
    // A remount (closing and reopening the panel, a re-render that swaps the surface)
    // gives B a fresh session on the SAME logical agent and thread while A is still
    // suspended -- which is precisely the detached-A / running-B case under test.
    cleanup();
    agent.answer = "B's answer";
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());

    // A REMOUNT IS A NEW PROVIDER, and therefore a new core with a new tool registry.
    // The session re-registers its own tools on it automatically; this fixture's tool has
    // to be re-added the same way, or B takes a tool call nothing can answer and the case
    // would fail for a reason that has nothing to do with the overlap under test.
    (realCore.current as CopilotKitCore).addTool({
      name: TOOL_NAME,
      description: "Read the schedule.",
      agentId: AGENT_ID,
      parameters: z.object({}),
      handler: async () => {
        toolCalls += 1;
        return "B's tool result";
      },
    });

    await act(async () => {
      await session.current!.send("try again please");
    });

    const [aAgent, bAgent] = agent.clones;
    expect(aAgent).toBeDefined();
    expect(bAgent).toBeDefined();

    // A's EXACT call id. Asserting on the result STRING alone was vacuous: the result
    // does not exist yet at the moment A is stopped, so the thing that actually leaks
    // is the dangling CALL.
    const aCallId = `${aAgent.hopInputs[0].runId}-call`;
    const bCallId = `${bAgent.hopInputs[0].runId}-call`;
    expect(aCallId).not.toBe(bCallId);

    /** A's call id must appear in none of these, at any point. */
    const aLeaks = async () => {
      const durable = await harness.db.assistantMessages.toArray();
      return {
        visible: JSON.stringify(agent.messages).includes(aCallId),
        durable: JSON.stringify(durable).includes(aCallId),
        canonical: JSON.stringify(await readThreadMessages(threadId)).includes(aCallId),
        hops: bAgent.hopInputs.some((hop) => JSON.stringify(hop.messages ?? []).includes(aCallId)),
      };
    };

    expect(await aLeaks()).toEqual({
      visible: false,
      durable: false,
      canonical: false,
      hops: false,
    });

    // B COMPLETED THE LOOP: two hops, its own tool result in the second hop's
    // provider history, and an answer.
    expect(bAgent.hopInputs).toHaveLength(2);
    const bFollowUpHistory = bAgent.hopInputs[1].messages ?? [];
    expect(bFollowUpHistory.some((message) => message.role === "tool")).toBe(true);
    const bAnswer = bAgent.messages.filter((message) => message.role === "assistant").at(-1);
    expect(String((bAnswer as { content?: unknown })?.content)).toContain("B's answer");

    // A NEVER GOT A FOLLOW-UP: it was stopped mid-tool.
    expect(aAgent.hopInputs).toHaveLength(1);

    // B's OWN pair is complete and durable -- the filter drops what is dangling, not
    // everything.
    const durableBefore = await harness.db.assistantMessages.toArray();
    const durableText = JSON.stringify(durableBefore);
    expect(durableText).toContain(bCallId);
    expect(durableBefore.some((message) => message.role === "tool")).toBe(true);

    // --- Snapshot B's world immediately before late A ----------------------
    const uiBefore = JSON.stringify({
      lastRefusal: useAssistantStore.getState().lastRefusal,
      lastSettlement: useAssistantStore.getState().lastSettlement,
      activeTurnId: useAssistantStore.getState().activeTurnId,
      authorizedTurnEpoch: useAssistantStore.getState().authorizedTurnEpoch,
      preparingTurnEpoch: useAssistantStore.getState().preparingTurnEpoch,
      streaming: useAssistantStore.getState().streaming,
      interruption: useAssistantStore.getState().interruption,
    });
    const visibleBefore = JSON.stringify(agent.messages);
    // The RENDERED surface, byte-for-byte.
    const domBefore = document.body.innerHTML;
    const boundBefore = readBoundTurn();
    const handleBefore = readActiveRunHandle();

    // --- Let A resume, and prove it changes nothing ------------------------
    releaseA?.();
    await aSend;
    await waitFor(() => expect(aResumed).toBe(true));

    // Still no second hop for A, and B's instance is untouched by A's cleanup.
    expect(aAgent.hopInputs).toHaveLength(1);
    expect(bAgent.hopInputs).toHaveLength(2);

    // B's Stop handle survived A's teardown -- or was cleanly cleared by B's own.
    const handleAfter = readActiveRunHandle();
    expect(handleAfter?.runId).not.toBe(aHandle!.runId);

    // THE RENDERED PROOF FIRST, because it is the claim that matters to a user: a late
    // turn that published a refusal or a settlement would change this markup. Store
    // assertions follow, but they could not have seen a rendered notice on their own.
    expect(document.body.innerHTML).toBe(domBefore);
    expect(document.body.innerHTML).not.toContain("assistant-refusal");
    expect(document.body.innerHTML).not.toContain("assistant-settlement");

    // NOTHING OF B'S CHANGED. A late unauthorized resolve makes no shared publication
    // at all, so every one of these is byte-for-byte what it was before A woke up.
    expect(
      JSON.stringify({
        lastRefusal: useAssistantStore.getState().lastRefusal,
        lastSettlement: useAssistantStore.getState().lastSettlement,
        activeTurnId: useAssistantStore.getState().activeTurnId,
        authorizedTurnEpoch: useAssistantStore.getState().authorizedTurnEpoch,
        preparingTurnEpoch: useAssistantStore.getState().preparingTurnEpoch,
        streaming: useAssistantStore.getState().streaming,
        interruption: useAssistantStore.getState().interruption,
      }),
    ).toBe(uiBefore);
    expect(JSON.stringify(agent.messages)).toBe(visibleBefore);
    expect(readBoundTurn()).toBe(boundBefore);
    expect(readActiveRunHandle()).toBe(handleBefore);

    // THE VISIBLE PANEL shows B's answer and none of A's superseded tool result.
    const visible = JSON.stringify(agent.messages);
    expect(visible).toContain("B's answer");
    expect(visible).not.toContain("A's superseded tool result");

    // AND A'S CALL ID IS STILL ABSENT EVERYWHERE, now that its result exists.
    expect(await aLeaks()).toEqual({
      visible: false,
      durable: false,
      canonical: false,
      hops: false,
    });

    const durable = await harness.db.assistantMessages.toArray();
    expect(JSON.stringify(durable)).toContain("B's answer");
    expect(JSON.stringify(durable)).not.toContain("A's superseded tool result");

    // And the turn rows tell the truth about both: A stopped, B completed.
    // Sorted by creation, because `toArray()` returns primary-key order and the ids
    // are UUIDs -- reading them positionally silently compared the wrong turns.
    const turns = (await harness.db.assistantTurns.toArray()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    expect(turns).toHaveLength(2);
    const [aTurn, bTurn] = turns;
    // A was stopped: it is settled, and it never claims to have completed.
    expect(aTurn.state).not.toBe("streaming");
    expect(aTurn.terminalReason).not.toBe("completed");
    // B did complete.
    expect(bTurn.terminalReason).toBe("completed");
  });

  it("prefers an authority refusal over a transport that would also have failed", async () => {
    // The turn is launched against a transport that fails, and the lease moves in the
    // window between the launch claim and the hop. The guard refuses, so the failure
    // never happens -- and the user is told the true cause, their takeover, rather
    // than a transport story that would have been equally true a moment later.
    agent.behaviour = "fail";
    revokeFromHopOnward = true;

    await send();

    // Refusing means refusing to SEND: the failing transport was never reached.
    expect(agent.runIds).toEqual([]);

    const turn = await lastTurn();
    expect(turn?.terminalReason).not.toBe("run_failed");
    // The refusal is what the panel reports, and no transport story is published.
    expect(useAssistantStore.getState().lastRefusal).not.toBeNull();
    expect(useAssistantStore.getState().lastSettlement?.settlement).not.toBe("run_failed");
  });
});
