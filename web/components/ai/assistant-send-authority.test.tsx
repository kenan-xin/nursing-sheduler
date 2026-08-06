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
let runAgent: ReturnType<typeof vi.fn>;
let abortRun: ReturnType<typeof vi.fn>;

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
] as const;

/**
 * Start a send and suspend it at `boundary`.
 *
 * The in-flight send is returned INSIDE a box: returning it bare would make the
 * caller's `await` unwrap it, which is a wait for the very thing being suspended.
 */
async function suspendSendAt(boundary: string): Promise<{ sent: Promise<void> }> {
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

  let sent!: Promise<void>;
  act(() => {
    sent = session.current!.send("why is the 15th short?");
  });
  await arrived;
  if (boundary === "readWriterContext") writerCheckpoint = async () => {};
  return { sent };
}

async function expectNoLaunch(inFlight: { sent: Promise<void> }): Promise<void> {
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

  // Only the boundaries BETWEEN the gate's ownership read and the launch check's
  // reread. Suspending before the first read means the turn is simply prepared
  // against the newer revision, and suspending after the reread is past the point
  // where a commit could still invalidate the basis this turn captured -- neither is
  // a stale send.
  it.each(BOUNDARIES.slice(1, 6))(
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
