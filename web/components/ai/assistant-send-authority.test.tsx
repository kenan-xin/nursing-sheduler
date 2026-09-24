// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Message } from "@ag-ui/client";

import { useAuthorityStore } from "@/lib/store";
import {
  assistantActions,
  hydrateAssistant,
  isTurnAuthorized,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
import { UNSETTLED_TURN_STATES, selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { useAssistantSession, type AssistantSession } from "./use-assistant-session";
import { useInterruptionWatch } from "./use-interruption-watch";

// PREPARATION IS THE WINDOW UNDER TEST.
//
// A send reads settings, ownership, the thread, its history and a durable turn row
// before it contacts the provider, and every one of those reads is an `await`. This
// suite suspends the send AT each of those boundaries, applies each T05 interruption
// and ownership trigger while it is suspended, and then lets it resume -- because the
// question the cold review asked is not "does the gate refuse?" but "can a send that
// already passed the gate still reach the provider afterwards?".
//
// Only the AGENT is faked. The store, the interruption controller, the Dexie fences,
// the turn rows and the ownership watch are all the shipped ones, so a pass here is a
// statement about the real protocol rather than about a stand-in for it.

const h = vi.hoisted(() => {
  const state = {
    /** The boundary to suspend at, consumed by the first arrival. */
    pausedAt: null as string | null,
    release: null as (() => void) | null,
    arrived: null as (() => void) | null,
    agent: null as unknown,
    /** Every boundary the send has passed. Only read to explain a stuck test. */
    seen: [] as string[],
  };

  /**
   * Suspend the caller AFTER the wrapped call resolved.
   *
   * After, not before, deliberately: pausing mid-transaction would hold a Dexie
   * transaction open and deadlock the interruption that the test is about to apply.
   * What is modelled is the caller sitting at its `await`, which is exactly the
   * window a revoked send can be launched from.
   */
  async function checkpoint(name: string): Promise<void> {
    state.seen.push(name);
    if (name !== state.pausedAt) return;
    state.pausedAt = null;
    await new Promise<void>((resolve) => {
      state.release = resolve;
      state.arrived?.();
    });
  }

  function instrument<T extends object>(actual: T, names: readonly string[]): T {
    const source = actual as Record<string, unknown>;
    const wrapped: Record<string, unknown> = { ...source };
    for (const name of names) {
      const original = source[name] as (...args: unknown[]) => Promise<unknown>;
      wrapped[name] = async (...args: unknown[]) => {
        const value = await original(...args);
        await checkpoint(name);
        return value;
      };
    }
    return wrapped as T;
  }

  return { state, instrument };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@copilotkit/react-core/v2", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useAgent: () => ({ agent: h.state.agent, isReady: true }),
    // Tool registration is T04/T06 behaviour with its own suites; this one is about
    // whether a run starts at all.
    useFrontendTool: () => {},
    // The session builds its OWN core per turn (see the session's note on the shared
    // `_runDepth`/`_runAbortController`), reading these public getters for its config.
    useCopilotKit: () => ({
      copilotkit: {
        runtimeUrl: "http://localhost/api/copilotkit",
        runtimeTransport: "sse",
        headers: {},
        credentials: undefined,
        properties: {},
        tools: [],
        debug: undefined,
      },
    }),
    // Stubbed so the per-turn core delegates straight to the fake agent: this suite is
    // about WHETHER a run starts, and a real core cannot drive a non-AG-UI fake. What
    // the real core does once it has an agent is proved in `session-real-core.test.tsx`
    // and `tool-loop.test.ts`.
    CopilotKitCore: class {
      // The session preserves runtime tool-disable overrides and attaches its own error
      // subscriber to the turn core; neither is what this suite is about.
      isToolEnabled() {
        return true;
      }
      setToolEnabled() {}
      subscribe() {
        return { unsubscribe: () => {} };
      }
      runAgent({
        agent,
        runId,
      }: {
        agent: { runAgent(i: { runId: string }): Promise<void> };
        runId: string;
      }) {
        return agent.runAgent({ runId });
      }
    },
  };
});

vi.mock("@/lib/ai/assistant/history-repo", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return h.instrument(actual, [
    "selectActiveThread",
    "readThreadMessages",
    "recordPreparingTurn",
    "persistThreadMessages",
    "readThread",
    "readTurn",
    "setTurnState",
    "scrubThreadHistory",
  ]);
});

vi.mock("@/lib/ai/assistant/settings-repo", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return h.instrument(actual, ["readAssistantSettings"]);
});

vi.mock("@/lib/ai/assistant/runtime-stop", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return h.instrument(actual, ["primeRuntimeInstanceId"]);
});

// The lease/envelope read has its own suite (`writer-context.test.ts`). Faking it here
// keeps this suite about the send protocol, and lets a test revoke ownership at an
// exact moment instead of racing a lease clock.
vi.mock("@/lib/ai/assistant/writer-context", () => ({
  readWriterContext: async () => {
    const value = writerContext;
    await writerCheckpoint();
    return value;
  },
}));

const SCENARIO_ID = "scenario-a";

const BASE_WRITER: WriterContext = {
  scenarioId: SCENARIO_ID,
  documentRevision: 12,
  leaseEpoch: 4,
  scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01", rangeEnd: "2026-09-30" },
};

let writerContext: WriterContext | null = BASE_WRITER;
let writerCheckpoint: () => Promise<void>;

/**
 * Arm the suspension and resolve once the send has reached it.
 *
 * The rejection arm turns "this boundary is never reached" into a message naming the
 * ones that were, instead of an opaque suite timeout.
 */
function pauseAt(name: string): Promise<void> {
  h.state.pausedAt = name;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    new Promise<void>((resolve) => {
      h.state.arrived = resolve;
    }),
    new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`never reached ${name}; saw ${h.state.seen.join(", ")}`)),
        2_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function resume(): Promise<void> {
  await act(async () => {
    h.state.release?.();
    h.state.release = null;
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// The fake agent
// ---------------------------------------------------------------------------

interface RunRecord {
  runId: string;
  authorizedTurnEpoch: number | null;
  authorized: boolean;
}

let runs: RunRecord[] = [];
/** When set, the next run reports a transport failure through the subscriber. */
let failNextRun = false;
/** Report that failure under a FOREIGN run id, to prove the latch is run-scoped. */
let failWithRunId: string | null = null;
let runAgent: ReturnType<typeof vi.fn>;
let abortRun: ReturnType<typeof vi.fn>;

/** The two session callbacks this fake delivers: a reply, and a run failure. */
interface FakeSubscriber {
  onRunFailed?: (params: { input: { runId: string } }) => void;
  onTextMessageEndEvent?: (params: {
    event: { type: string; messageId?: string };
    textMessageBuffer: string;
    input: { runId: string };
  }) => void;
}

function createFakeAgent() {
  abortRun = vi.fn();
  runAgent = vi.fn(async (input: { runId: string }) => {
    const state = useAssistantStore.getState();
    runs.push({
      runId: input.runId,
      authorizedTurnEpoch: state.authorizedTurnEpoch,
      // The exact expression the shipped tool guard evaluates.
      authorized: isTurnAuthorized(state.authorizedTurnEpoch ?? -1, state),
    });
    agent.isRunning = true;
    await Promise.resolve();
    // A RUN THAT REACHES THE PROVIDER REPLIES, always. The session calls a turn
    // `completed` only when it produced assistant text, so a fake that stayed silent
    // would model the live defect rather than an ordinary send -- and every case here
    // is about WHETHER a run starts, not about what it said.
    agent.subscriber?.onTextMessageEndEvent?.({
      event: { type: "TEXT_MESSAGE_END", messageId: `${input.runId}-answer` },
      // The COMPLETED buffer, as the locked contract hands it over. A boundary alone is
      // not a reply: the session requires visible content in this exact field.
      textMessageBuffer: "a real answer",
      input: { runId: input.runId },
    });
    // A failing transport reports through the subscriber and still RESOLVES, which is
    // the locked core's behaviour. Opt in per test. Delivered with the concrete run
    // input, because the session filters callbacks on `input.runId` -- a failure it
    // cannot attribute to its own run is ignored, which is what the foreign-run case
    // asserts. It comes AFTER the reply so an ignored foreign failure still leaves an
    // ordinary, productive turn behind.
    if (failNextRun) {
      agent.subscriber?.onRunFailed?.({ input: { runId: failWithRunId ?? input.runId } });
    }
    agent.isRunning = false;
  });

  const agent = {
    agentId: "scheduler:thread",
    messages: [] as Message[],
    isRunning: false,
    setMessages(next: Message[]) {
      agent.messages = [...next];
    },
    addMessage(message: Message) {
      agent.messages = [...agent.messages, message];
    },
    abortRun,
    runAgent,
    // The session installs the provider-hop guard on the agent and subscribes for the
    // whole turn. Neither is exercised here (the fake agent has no transport), but
    // both must exist for the hook to run at all.
    use: () => agent,
    // The session runs each turn on a dedicated clone. This suite is about WHETHER a
    // run starts, so the clone is the same object: every assertion below still observes
    // the one `runAgent` spy. The isolation the clone buys is proved against real
    // agents in `tool-loop.test.ts`.
    clone: () => agent,
    // The subscriber is CAPTURED, so a test can deliver the public run-failure signal
    // the way the agent would. `runAgent` resolving without rejecting is the real
    // contract; the failure arrives here instead.
    subscribe: (subscriber: FakeSubscriber) => {
      agent.subscriber = subscriber;
      return { unsubscribe: () => {} };
    },
    subscriber: null as FakeSubscriber | null,
  };
  return agent;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let harness: AssistantHarness;
let threadId: string;
let requested: string[];
const session: { current: AssistantSession | null } = { current: null };

function Host() {
  useInterruptionWatch();
  session.current = useAssistantSession({
    threadId,
    routePath: "/shift-requests",
    routeLabel: "Requests",
    historical: false,
  });
  return null;
}

function installFetch() {
  requested = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    requested.push(String(url));
    if (String(url).includes("/stop/")) {
      return new Response(JSON.stringify({ stopped: true }), { status: 200 });
    }
    if (String(url).includes("/api/copilotkit")) {
      return new Response(
        JSON.stringify({ agents: {}, mode: "sse", runtimeInstanceId: "instance-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();
  h.state.pausedAt = null;
  h.state.release = null;
  h.state.arrived = null;
  h.state.agent = createFakeAgent();
  runs = [];
  failNextRun = false;
  failWithRunId = null;
  writerContext = BASE_WRITER;
  writerCheckpoint = async () => {};
  installFetch();

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

/** Every unsettled turn left behind. A revoked send must leave none. */
async function unsettledTurns() {
  const turns = await harness.db.assistantTurns.toArray();
  return turns.filter((turn) => UNSETTLED_TURN_STATES.includes(turn.state));
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/**
 * The nine T05 triggers, each applied the way the app applies it and awaited to
 * settlement. The last three arrive through the authority projection rather than a
 * control, which is exactly why a turn still PREPARING has to count as live work.
 */
const TRIGGERS = [
  {
    name: "stop",
    apply: async () => {
      await assistantActions.interrupt({ trigger: "stop", threadId, scenarioId: SCENARIO_ID });
    },
  },
  {
    name: "disable",
    apply: async () => {
      await assistantActions.setEnabled(false, { threadId, scenarioId: SCENARIO_ID });
    },
  },
  {
    name: "remove_key",
    apply: async () => {
      await assistantActions.removeKey({ threadId, scenarioId: SCENARIO_ID });
    },
  },
  {
    name: "replace_configuration",
    apply: async () => {
      await assistantActions.activate(
        { apiKey: "sk-or-REPLACEMENT-0002", modelId: "vendor/other", modelSource: "custom" },
        { threadId, scenarioId: SCENARIO_ID },
      );
    },
  },
  {
    name: "clear_history",
    apply: async () => {
      await assistantActions.clearHistory({ threadId, scenarioId: SCENARIO_ID });
    },
  },
  {
    name: "clear_all",
    apply: async () => {
      await assistantActions.clearAll({ threadId, scenarioId: SCENARIO_ID });
    },
  },
  {
    name: "scenario_switch",
    apply: async () => {
      // The envelope names the new document now, so a gate that has not run yet
      // selects the new thread and a turn already prepared is revoked.
      writerContext = { ...BASE_WRITER, scenarioId: "scenario-b" };
      act(() => {
        useAuthorityStore.setState({ scenarioId: "scenario-b" });
      });
      await waitFor(() =>
        expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("scenario_switch"),
      );
    },
  },
  {
    name: "lease_lost",
    apply: async () => {
      writerContext = null;
      act(() => {
        useAuthorityStore.setState({ ownership: "expired" });
      });
      await waitFor(() =>
        expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("lease_lost"),
      );
    },
  },
  {
    name: "takeover",
    apply: async () => {
      writerContext = null;
      act(() => {
        useAuthorityStore.setState({ ownership: "taken-over" });
      });
      await waitFor(() =>
        expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("takeover"),
      );
    },
  },
] as const;

/**
 * Every await boundary between the epoch claim and the provider call.
 *
 * `primeRuntimeInstanceId` is deliberately absent: it runs BEFORE the turn epoch is
 * claimed, so a trigger landing there revokes nothing -- the send simply prepares
 * afresh against the new state, which is correct rather than stale.
 */
const BOUNDARIES = [
  "readAssistantSettings",
  "readWriterContext",
  "selectActiveThread",
  "readThreadMessages",
  "recordPreparingTurn",
  "persistThreadMessages",
  "readThread",
  "readTurn",
  "setTurnState",
  // The scrub, and it is in this list because it once was not. It used to run AFTER
  // the final identity check, so a send suspended in it could resume past a Stop and
  // take the shared handle, binding and lifecycle from the turn that replaced it. It
  // is an ordinary preparation await now, and this matrix is what keeps it one.
  "scrubThreadHistory",
] as const;

/**
 * Start a send and suspend it at `boundary`.
 *
 * The in-flight send is returned INSIDE a box: returning it bare would make the
 * caller's `await` unwrap it, which is a wait for the very thing being suspended.
 */
async function suspendSendAt(boundary: string): Promise<{ sent: Promise<unknown> }> {
  const arrived =
    boundary === "readWriterContext"
      ? new Promise<void>((resolve) => {
          writerCheckpoint = () =>
            new Promise<void>((release) => {
              h.state.release = release;
              resolve();
            });
        })
      : pauseAt(boundary);

  let sent!: Promise<unknown>;
  act(() => {
    sent = session.current!.send("why is the 15th short?");
  });
  await arrived;
  if (boundary === "readWriterContext") writerCheckpoint = async () => {};
  return { sent };
}

async function expectNoLaunch(inFlight: { sent: Promise<unknown> }): Promise<void> {
  await resume();
  await act(async () => {
    await inFlight.sent;
  });

  expect(runAgent).not.toHaveBeenCalled();
  expect(runs).toEqual([]);
  // The refusal is stated rather than the send silently evaporating.
  expect(useAssistantStore.getState().lastRefusal).not.toBeNull();
  // Nothing is left claiming to be in flight -- the prepared turn is settled or gone.
  expect(await unsettledTurns()).toEqual([]);
  expect(useAssistantStore.getState().preparingTurnEpoch).toBeNull();
  for (const url of requested) {
    expect(url).not.toContain("/agent/scheduler/run");
    expect(url).not.toContain("openrouter.ai");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the final synchronous check, at its own race boundary", () => {
  // THE WINDOW THIS CHECK EXISTS FOR, and nowhere else is it observable.
  //
  // Every await above the launch claim is covered by the boundary matrix, and the claim
  // itself rereads the durable writer -- so a trigger landing before the claim is
  // rejected by the claim. What the claim CANNOT see is a revocation that lands while
  // its own read is in flight: it returns the writer it read, and by then the gate may
  // have closed. The synchronous identity comparison that follows, with no await
  // between it and `runAgent`, is the only thing standing there.
  //
  // So the pause is armed on the CLAIM'S read specifically -- the first
  // `readWriterContext` after `setTurnState`, which the send performs only once -- and
  // not on any earlier one, which a different mechanism would already have caught.

  /** Suspend the send inside the launch claim's own durable read. */
  async function suspendInsideClaim() {
    const atStateWrite = await suspendSendAt("setTurnState");

    let engaged = false;
    const reached = new Promise<void>((resolve) => {
      writerCheckpoint = () =>
        new Promise<void>((release) => {
          engaged = true;
          h.state.release = release;
          resolve();
        });
    });

    // Let the state write finish; the very next writer read is the claim's.
    await act(async () => {
      h.state.release?.();
      h.state.release = null;
      await Promise.resolve();
    });
    await reached;
    // Operation-specific engagement: the claim's own read is what is suspended.
    expect(engaged).toBe(true);
    writerCheckpoint = async () => {};
    return atStateWrite;
  }

  it.each(["stop", "takeover", "scenario_switch"])(
    "refuses a send whose authority died inside the claim (%s)",
    async (name) => {
      const inFlight = await suspendInsideClaim();
      const trigger = TRIGGERS.find((entry) => entry.name === name)!;
      await trigger.apply();

      await expectNoLaunch(inFlight);
    },
  );

  it("refuses one whose document moved under it inside the claim", async () => {
    // Not an interruption: an ordinary same-tab commit moves the revision without
    // disturbing the turn, so only the identity comparison can see it.
    const inFlight = await suspendInsideClaim();
    act(() => {
      useAuthorityStore.setState({ documentRevision: 13 });
    });

    await expectNoLaunch(inFlight);
  });

  it("launches when only the lease advanced inside the claim, because nothing could see it", async () => {
    // NOT A GAP, AND WORTH STATING. A peer's lease advance is a DURABLE fact: it moves
    // no turn epoch, closes no gate and changes nothing the live projection carries, so
    // the synchronous comparison has nothing to compare. The claim's own reread is its
    // boundary -- and a lease that advanced while that read was in flight was not there
    // to be read. The send therefore proceeds under the writer it legitimately claimed,
    // and the hop guard, which rereads on every hop, is what catches the advance next.
    //
    // Asserting the launch rather than omitting the case: this is the one trigger the
    // final check provably cannot cover, and a reader deserves to know that is by
    // construction rather than by oversight.
    const inFlight = await suspendInsideClaim();
    writerContext = { ...BASE_WRITER, leaseEpoch: BASE_WRITER.leaseEpoch + 1 };

    await resume();
    await act(async () => {
      await inFlight.sent;
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe("an undisturbed send", () => {
  it("reaches the provider, authorised under its own epoch", async () => {
    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    // Without this the whole suite below could pass by never sending anything.
    expect(runs[0].authorized).toBe(true);
    expect(useAssistantStore.getState().lastRefusal).toBeNull();
    expect(await unsettledTurns()).toEqual([]);
    // The success case, so the failure case below cannot pass vacuously.
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
  });

  it("settles a FAILED transport as run_failed, not completed", async () => {
    // `copilotkit.runAgent` resolves even when the agent run fails -- the locked core
    // catches the error and returns an empty result -- so a session relying on `catch`
    // recorded `completed` for a turn whose transport died. The failure arrives on the
    // agent subscriber instead, and this asserts the DURABLE turn and the UI, not the
    // returned promise.
    failNextRun = true;

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });

    expect(runAgent).toHaveBeenCalledTimes(1);

    const turns = await harness.db.assistantTurns.toArray();
    const settled = turns.at(-1);
    expect(settled?.state).toBe("detached");
    expect(settled?.terminalReason).toBe("run_failed");

    expect(useAssistantStore.getState().lastSettlement).toMatchObject({
      settlement: "run_failed",
    });
    // A transport failure is not an interruption, and must not be attributed to one.
    expect(useAssistantStore.getState().lastSettlement?.trigger).toBeNull();
    // Nor is it an authority refusal.
    expect(useAssistantStore.getState().lastRefusal).toBeNull();
  });

  it("ignores a failure reported under a run it does not own", async () => {
    // AG-UI hands the concrete `input` to every subscriber on an agent. A latch that
    // ignored it would let an overlapping run's failure settle this turn -- the exact
    // cross-wiring the run-scoped filter exists to prevent. The turn must complete.
    failNextRun = true;
    failWithRunId = "some-other-run";

    await act(async () => {
      await session.current!.send("why is the 15th short?");
    });

    const turns = await harness.db.assistantTurns.toArray();
    const settled = turns.at(-1);
    expect(settled?.state).toBe("terminal");
    expect(settled?.terminalReason).toBe("completed");
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
  });
});

describe("a prepared send whose authority closed while it was preparing", () => {
  it.each(TRIGGERS.map((trigger) => [trigger.name, trigger] as const))(
    "makes no provider call after %s",
    async (_name, trigger) => {
      const inFlight = await suspendSendAt("recordPreparingTurn");

      await act(async () => {
        await trigger.apply();
      });

      await expectNoLaunch(inFlight);
    },
  );

  it.each(BOUNDARIES)("makes no provider call when Stop lands at %s", async (boundary) => {
    const inFlight = await suspendSendAt(boundary);

    await act(async () => {
      await assistantActions.interrupt({ trigger: "stop", threadId, scenarioId: SCENARIO_ID });
    });

    await expectNoLaunch(inFlight);
  });

  it.each(BOUNDARIES)("makes no provider call when a takeover lands at %s", async (boundary) => {
    const inFlight = await suspendSendAt(boundary);

    await act(async () => {
      await TRIGGERS[8].apply();
    });

    await expectNoLaunch(inFlight);
  });

  // Every boundary after the gate's ownership read. Suspending before that read means
  // the turn is simply prepared against the newer revision, which is correct rather
  // than stale; everything after it is a window in which the basis this turn captured
  // can move under it.
  //
  // The three LAST boundaries are the point: a document commit or a lease advance
  // there moves no turn epoch, invalidates no turn row and needs no interruption, so
  // nothing but a claim taken after the streaming-state write can see them.
  it.each(BOUNDARIES.slice(1))(
    "makes no provider call when the schedule is committed under it at %s",
    async (boundary) => {
      const inFlight = await suspendSendAt(boundary);

      // No interruption at all: an ordinary save. The context this turn is about to
      // send describes the document at the revision it was read at.
      writerContext = { ...BASE_WRITER, documentRevision: 13 };

      await expectNoLaunch(inFlight);
    },
  );
});

// ---------------------------------------------------------------------------
// The launch claim
// ---------------------------------------------------------------------------
//
// These are the changes that arrive with NO local evidence at all: an ordinary
// same-tab commit, a lease reissued under a new epoch, a peer takeover whose
// BroadcastChannel hint has not landed yet. None of them interrupts anything, and the
// thread and turn rows stay perfectly valid -- so a send suspended at the thread read,
// the turn read or the streaming-state write would launch against a schedule that has
// already moved unless the persisted authority is claimed again afterwards.

/** The boundaries after the durable rereads have already happened. */
const LATE_BOUNDARIES = BOUNDARIES.slice(6);

const LATE_AUTHORITY_CHANGES: readonly [string, WriterContext | null][] = [
  ["the schedule is committed under it", { ...BASE_WRITER, documentRevision: 13 }],
  ["the lease is reissued under a new epoch", { ...BASE_WRITER, leaseEpoch: 5 }],
  ["another tab takes over before its hint arrives", null],
];

/**
 * A refused launch must leave its turn SETTLED as revoked -- nothing was sent, and
 * saying so durably is what keeps a reload from adopting it as unfinished work.
 */
async function expectRevokedTurns(): Promise<void> {
  const turns = await harness.db.assistantTurns.toArray();
  expect(turns.length).toBeGreaterThan(0);
  expect(turns.map((turn) => [turn.state, turn.terminalReason])).toEqual(
    turns.map(() => ["terminal", "revoked"]),
  );
}

describe("a send whose document or lease authority moved after its durable rereads", () => {
  it.each(
    LATE_BOUNDARIES.flatMap((boundary) =>
      LATE_AUTHORITY_CHANGES.map(
        ([label, writer]) => [boundary, label, writer] as [string, string, WriterContext | null],
      ),
    ),
  )("makes no provider call at %s when %s", async (boundary, _label, writer) => {
    const inFlight = await suspendSendAt(boundary);

    // Persisted only: no interruption, no epoch movement, no projection hint.
    writerContext = writer;

    await expectNoLaunch(inFlight);
    await expectRevokedTurns();
  });

  // The claim is a durable read, and a durable read is a moment in the PAST by the
  // time its promise resolves. This is the case only the synchronous comparison can
  // catch: the persisted read still answers revision 12 while the commit has already
  // published 13 to the projection.
  it.each(LATE_BOUNDARIES)(
    "makes no provider call when a commit publishes to the projection at %s",
    async (boundary) => {
      const inFlight = await suspendSendAt(boundary);

      act(() => {
        useAuthorityStore.setState({ documentRevision: 13 });
      });

      await expectNoLaunch(inFlight);
      await expectRevokedTurns();
    },
  );
});

describe("two submits racing through preparation", () => {
  it("launches at most one run and leaves the first turn authorised", async () => {
    const first = await suspendSendAt("recordPreparingTurn");

    await act(async () => {
      await session.current!.send("and the 16th?");
    });

    // The second submit never claims an epoch. Claiming one would drop
    // `authorizedTurnEpoch` and de-authorise the turn that is about to run.
    expect(useAssistantStore.getState().lastRefusal).toBe("busy");

    await resume();
    await act(async () => {
      await first.sent;
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runs[0].authorized).toBe(true);
    expect(await harness.db.assistantTurns.count()).toBe(1);
  });
});
