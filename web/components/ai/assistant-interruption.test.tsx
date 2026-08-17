// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { useAuthorityStore } from "@/lib/store";
import {
  assistantActions,
  hydrateAssistant,
  isTurnAuthorized,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
import {
  persistThreadMessages,
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
} from "@/lib/ai/assistant/history-repo";
import { setDiagnosticCanceller } from "@/lib/ai/assistant/diagnostic-cancellation";
import { resetRuntimeInstanceForTest, setActiveRunHandle } from "@/lib/ai/assistant/runtime-stop";
import { readLifecycleLog, resetLifecycleLog } from "@/lib/ai/assistant/lifecycle";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  createDiagnosticFixture,
  dumpDatabase,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import { setSettlementWindowForTest } from "@/lib/ai/assistant/store";
import { AssistantSurface, useAssistantHydration } from "./assistant-surface";
import { ownershipLossTrigger } from "./use-interruption-watch";

/**
 * What `app-shell.tsx` mounts: the hydration/watch hook ABOVE the panel, plus the
 * panel itself. The ownership and identity triggers live in that hook rather than in
 * the surface, because a takeover must interrupt a turn even with the panel closed --
 * so a test that rendered only `AssistantSurface` would not be testing the shipped
 * arrangement.
 */
function Shell() {
  useAssistantHydration();
  return <AssistantSurface />;
}

/** Forget the settlements `makeReady` itself produced, so a test asserts only its own. */
function clearSettlementHistory() {
  useAssistantStore.setState({ lastSettlement: null });
  resetLifecycleLog();
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

function setViewport(): void {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const SCENARIO_ID = "scenario-a";

let harness: AssistantHarness;
let requested: string[];
let stopAnswer: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  requested = [];
  stopAnswer = () => json({ stopped: true });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/stop/")) return stopAnswer();
    if (url.includes("/api/copilotkit")) {
      return json({
        agents: { scheduler: { description: "Scheduler" } },
        mode: "sse",
        runtimeInstanceId: "instance-1",
        telemetryDisabled: true,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function makeReady() {
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
}

function seedAuthority(ownership: "owner" | "read-only" | "taken-over" | "expired") {
  useAuthorityStore.setState({
    scenarioId: SCENARIO_ID,
    documentRevision: 12,
    recordRevision: 20,
    ownership,
  });
}

/**
 * A turn mid-stream, exactly as a real send leaves the world: a durable `streaming`
 * turn, one persisted message, the store authorised under the turn's epoch, and an
 * abortable run handle published for the controller.
 *
 * Seeded rather than driven through a live provider stream on purpose. What is under
 * test is the interruption contract, and faking the agent is the only part of the path
 * that is faked -- the store wiring, the Dexie fences and the stop client are all real.
 */
async function seedStreamingTurn() {
  const thread = await selectActiveThread(SCENARIO_ID, harness.config);
  const turn = await recordPreparingTurn(
    {
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
      basisDocumentRevision: 12,
      leaseEpoch: 1,
      modelId: TEST_MODEL,
      runId: "run-1",
      turnEpoch: 1,
      runtimeInstanceId: "instance-1",
    },
    harness.config,
  );
  if (!turn) throw new Error("expected a live thread");
  await setTurnState(turn.turnId, { state: "streaming" }, harness.config);

  const writeContext = {
    threadId: thread.threadId,
    scenarioId: SCENARIO_ID,
    modelId: TEST_MODEL,
    turnId: turn.turnId,
    globalGeneration: turn.globalGeneration,
    scenarioGeneration: turn.scenarioGeneration,
    createdAt: harness.now().toISOString(),
  };
  await persistThreadMessages(
    [{ id: "m1", role: "user", content: "why is the 15th short?" }],
    writeContext,
    harness.config,
  );

  const abort = vi.fn();
  const epoch = assistantActions.nextTurnEpoch();
  assistantActions.beginTurn(turn.turnId, epoch);
  setActiveRunHandle({ threadId: thread.threadId, runId: "run-1", abort });

  return { thread, turn, abort, epoch, writeContext };
}

/**
 * The exact expression the registered tool guard evaluates.
 *
 * `components/ai/use-context-tools.ts` compares the LIVE store epoch against the epoch
 * it was registered with, and `use-assistant-session.ts` registers it with the
 * AUTHORISED epoch (`authorizedTurnEpoch ?? -1`). Reproducing both halves here is what
 * makes this a test of the shipped gate rather than of a helper beside it.
 */
function toolGateOpen(): boolean {
  const state = useAssistantStore.getState();
  const registeredEpoch = state.authorizedTurnEpoch ?? -1;
  return state.turnEpoch === registeredEpoch;
}

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  setDiagnosticCanceller(null);
  setSettlementWindowForTest(null);
  resetRuntimeInstanceForTest();
  resetLifecycleLog();
  installFetch();
  setViewport();
  await hydrateAssistant();
  seedAuthority("owner");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Stop", () => {
  it("aborts locally, stops the server-side run, and settles the turn as Stopped", async () => {
    const { turn, abort, thread } = await seedStreamingTurn();

    const result = await assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    expect(abort).toHaveBeenCalledTimes(1);
    // The browser abort alone would leave the provider call streaming server-side.
    expect(requested.some((url) => url.includes(`/stop/${thread.threadId}`))).toBe(true);
    expect(result.settlement).toBe("stopped");
    expect((await harness.db.assistantTurns.get(turn.turnId))?.state).toBe("terminal");
    expect((await harness.db.assistantTurns.get(turn.turnId))?.terminalReason).toBe("stopped");
    expect((await harness.db.assistantTurns.get(turn.turnId))?.interruptionTrigger).toBe("stop");
  });

  it("closes the tool gate and keeps it closed across re-renders", async () => {
    const { thread, epoch } = await seedStreamingTurn();
    expect(toolGateOpen()).toBe(true);
    expect(isTurnAuthorized(epoch)).toBe(true);

    await assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    expect(toolGateOpen()).toBe(false);
    expect(isTurnAuthorized(epoch)).toBe(false);
    // The regression this guards: comparing the live epoch against a COPY of itself
    // re-equalises on the next render. A re-render must not reopen the gate.
    useAssistantStore.setState({ panelOpen: true });
    expect(toolGateOpen()).toBe(false);
    // ...and a handler registered under the new live epoch is still unauthorised,
    // because no turn is authorised at all.
    expect(isTurnAuthorized(useAssistantStore.getState().turnEpoch)).toBe(false);
  });

  it("keeps the partial output it already accepted", async () => {
    const { thread } = await seedStreamingTurn();

    await assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    const messages = await harness.db.assistantMessages
      .where("threadId")
      .equals(thread.threadId)
      .toArray();
    expect(messages.map((m) => m.content)).toEqual(["why is the 15th short?"]);
  });

  it("makes no new provider request after the gate closes", async () => {
    const { thread } = await seedStreamingTurn();
    requested.length = 0;

    await assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    for (const url of requested) {
      expect(url).not.toContain("/agent/scheduler/run");
      expect(url).not.toContain("/agent/scheduler/connect");
      expect(url).not.toContain("openrouter.ai");
    }
  });

  it.each([
    ["a restarted runtime", () => json({ stopped: false, detached: true }), "detached_runtime"],
    ["an unknown thread", () => json({ stopped: false }), "detached_runtime"],
    ["an unreachable runtime", () => json({ error: "boom" }, 500), "detached_runtime"],
  ] as const)("detaches on %s, never as a completion", async (_label, answer, expected) => {
    const { turn, thread } = await seedStreamingTurn();
    stopAnswer = answer;

    const result = await assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    expect(result.settlement).toBe(expected);
    const settled = await harness.db.assistantTurns.get(turn.turnId);
    expect(settled?.state).toBe("detached");
    expect(settled?.terminalReason).not.toBe("completed");
  });
});

describe("the panel states what is happening", () => {
  it("shows Stopping while settling and the settlement once it is done", async () => {
    await makeReady();
    const { thread } = await seedStreamingTurn();
    assistantActions.openPanel();
    render(<AssistantSurface />);
    await screen.findByTestId("assistant-dock");

    // A stop whose cancellation never confirms, so the settling state is observable,
    // plus a settlement window this test closes by hand.
    setDiagnosticCanceller(createDiagnosticFixture({ hang: true }));
    let closeWindow: (() => void) | undefined;
    setSettlementWindowForTest(
      (ms) =>
        new Promise<void>((resolve) => {
          expect(ms).toBe(15_000);
          closeWindow = resolve;
        }),
    );

    const pending = assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    // Explicit budget rather than the 1s default: `closing` -> `settling` is gated on
    // a Dexie read of the unsettled turns plus one write per turn, and under the full
    // parallel suite those transactions can take longer than a second on their own.
    // The default made this assertion sample a still-`closing` panel reproducibly
    // while passing in isolation. The PRODUCT budget under test is the 15-second
    // settlement window asserted below, which is unchanged.
    await waitFor(
      () => {
        const notice = screen.getByTestId("assistant-interrupting");
        expect(notice).toHaveAttribute("data-phase", "settling");
        // Never "cancelled" before a terminal acknowledgement.
        expect(notice.textContent ?? "").toMatch(/Stopping\. Waiting/);
      },
      { timeout: 5_000 },
    );

    // The window is armed a step AFTER the settling phase is published, so wait for it
    // rather than assuming the two happen in the same tick.
    await waitFor(() => expect(closeWindow).toBeDefined());
    closeWindow?.();
    await pending;

    await waitFor(() => {
      const notice = screen.getByTestId("assistant-settlement");
      expect(notice).toHaveAttribute("data-settlement", "detached_timeout");
      expect(notice.textContent ?? "").toMatch(/could not be confirmed within 15 seconds/);
      expect(notice.textContent ?? "").toMatch(/nothing in your schedule was changed/i);
    });
  });

  it("exposes no raw provider or transport failure", async () => {
    await makeReady();
    const { thread } = await seedStreamingTurn();
    stopAnswer = () =>
      json({ error: "Failed to stop agent", message: "ECONNRESET at upstream" }, 500);
    assistantActions.openPanel();
    const { container } = render(<AssistantSurface />);
    await screen.findByTestId("assistant-dock");

    await assistantActions.interrupt({
      trigger: "stop",
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    await waitFor(() => expect(screen.getByTestId("assistant-settlement")).toBeInTheDocument());
    expect(container.innerHTML).not.toContain("ECONNRESET");
    expect(container.innerHTML).not.toContain("Failed to stop agent");
    expect(container.innerHTML).not.toContain(SENTINEL_KEY);
  });
});

describe("non-destructive interruptions", () => {
  it("Disable keeps the key, the preferences, the history and the fences", async () => {
    await makeReady();
    const { thread } = await seedStreamingTurn();

    await assistantActions.setEnabled(false, {
      threadId: thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    const settings = await harness.db.assistantSettings.get("local");
    expect(settings).toMatchObject({ enabled: false, apiKey: SENTINEL_KEY, modelId: TEST_MODEL });
    expect(await harness.db.assistantMessages.count()).toBe(1);
    expect((await harness.db.assistantGenerations.get("scenario:scenario-a"))?.generation).toBe(0);
    // The panel hides only AFTER local detachment.
    expect(useAssistantStore.getState().panelOpen).toBe(false);
  });

  it("Remove key deletes the credential BEFORE the stop, and settles without it", async () => {
    await makeReady();
    const { thread, turn } = await seedStreamingTurn();
    const keyAtStop: (string | null | undefined)[] = [];
    stopAnswer = () => {
      // Sampled at the moment the stop route is called.
      keyAtStop.push(useAssistantStore.getState().settings.apiKey);
      return json({ stopped: true });
    };

    await assistantActions.removeKey({ threadId: thread.threadId, scenarioId: SCENARIO_ID });

    expect(keyAtStop).toEqual([null]);
    // Settlement completed anyway: the runtime's stop route is keyless by design.
    expect((await harness.db.assistantTurns.get(turn.turnId))?.state).toBe("terminal");
    // History and the model preference survive.
    expect(await harness.db.assistantMessages.count()).toBe(1);
    expect(await harness.db.assistantSettings.get("local")).toMatchObject({
      apiKey: null,
      modelId: TEST_MODEL,
    });
  });

  it("Replace configuration interrupts BEFORE the new pair is activated", async () => {
    await makeReady();
    const { thread } = await seedStreamingTurn();
    const modelAtStop: (string | null)[] = [];
    stopAnswer = () => {
      modelAtStop.push(useAssistantStore.getState().settings.modelId);
      return json({ stopped: true });
    };

    await assistantActions.activate(
      { apiKey: SENTINEL_KEY, modelId: "openai/gpt-5", modelSource: "custom" },
      { threadId: thread.threadId, scenarioId: SCENARIO_ID },
    );

    // The old configuration's work was closed while the OLD model was still current.
    expect(modelAtStop).toEqual([TEST_MODEL]);
    expect(await harness.db.assistantSettings.get("local")).toMatchObject({
      modelId: "openai/gpt-5",
    });
    // Same-scenario history is retained across a configuration change.
    expect(await harness.db.assistantMessages.count()).toBe(1);
  });
});

describe("takeover and lease loss", () => {
  it.each([
    ["taken-over", "takeover"],
    ["expired", "lease_lost"],
    ["read-only", "lease_lost"],
  ] as const)("classifies a fall from owner to %s", (next, expected) => {
    expect(ownershipLossTrigger("owner", next)).toBe(expected);
  });

  it("is not a loss when this tab was never the owner, or still is", () => {
    expect(ownershipLossTrigger("read-only", "taken-over")).toBeNull();
    expect(ownershipLossTrigger("owner", "owner")).toBeNull();
  });

  it("interrupts a live turn when another tab takes over, and accepts no later write", async () => {
    await makeReady();
    const seeded = await seedStreamingTurn();
    clearSettlementHistory();
    assistantActions.openPanel();
    render(<Shell />);
    await screen.findByTestId("assistant-dock");

    seedAuthority("taken-over");

    await waitFor(() =>
      expect(useAssistantStore.getState().lastSettlement?.trigger).toBe("takeover"),
    );
    expect(seeded.abort).toHaveBeenCalled();
    // The tab is read-only now: the live conversation (the only thing that mounts an
    // agent, its tools and an input) is gone.
    await waitFor(() =>
      expect(screen.queryByTestId("assistant-live-conversation")).not.toBeInTheDocument(),
    );
    expect(toolGateOpen()).toBe(false);
    // A late tool result cannot be published under the closed epoch.
    expect(isTurnAuthorized(seeded.epoch)).toBe(false);
  });

  it("ignores an ownership change when nothing is in flight", async () => {
    await makeReady();
    clearSettlementHistory();
    render(<Shell />);

    seedAuthority("taken-over");

    // No live turn means nothing to interrupt, and announcing a settlement the user
    // never started would be noise.
    await Promise.resolve();
    expect(useAssistantStore.getState().lastSettlement).toBeNull();
    expect(readLifecycleLog()).toEqual([]);
  });
});

describe("Clear all from Settings", () => {
  it("deletes the key first, the content after settlement, and keeps the fences", async () => {
    await makeReady();
    const seeded = await seedStreamingTurn();

    const result = await assistantActions.clearAll({
      threadId: seeded.thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    expect(result.status).toBe("deleted");
    expect(result.scope).toBe("all");
    expect(await harness.db.assistantSettings.count()).toBe(0);
    expect(await harness.db.assistantMessages.count()).toBe(0);
    expect(await harness.db.assistantThreads.count()).toBe(0);
    expect((await harness.db.assistantGenerations.get("global"))?.generation).toBe(1);

    // The credential is gone from EVERY table, not just its own row.
    const dump = await dumpDatabase(harness.db);
    for (const [table, contents] of Object.entries(dump)) {
      expect(contents, table).not.toContain(SENTINEL_KEY);
    }
  });

  it("survives a reload and a late callback afterwards", async () => {
    await makeReady();
    const seeded = await seedStreamingTurn();
    await assistantActions.clearAll({
      threadId: seeded.thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    // RELOAD: a new page lifetime, so the epoch and every in-memory flag are gone.
    assistantActions.resetForTest();
    await hydrateAssistant();

    // The late callback still holds the generations its turn captured.
    const late = await persistThreadMessages(
      [{ id: "m-late", role: "assistant", content: "a chunk that arrived far too late" }],
      seeded.writeContext,
      harness.config,
    );

    expect(late).toBe("fenced");
    expect(await harness.db.assistantMessages.count()).toBe(0);
  });

  it("blocks a send while the clear is still settling", async () => {
    await makeReady();
    const seeded = await seedStreamingTurn();
    setDiagnosticCanceller(createDiagnosticFixture({ hang: true }));
    let closeWindow: (() => void) | undefined;
    setSettlementWindowForTest(
      () =>
        new Promise<void>((resolve) => {
          closeWindow = resolve;
        }),
    );

    const pending = assistantActions.clearHistory({
      threadId: seeded.thread.threadId,
      scenarioId: SCENARIO_ID,
    });

    // Stop and Clear history both leave a Ready configuration behind, so readiness
    // cannot be what closes this door.
    // `send-gate.test.ts` owns the refusal itself; what matters here is that the flag
    // the session hook feeds it is set for the whole settling window.
    await waitFor(() => expect(useAssistantStore.getState().interruption).not.toBeNull());
    expect(useAssistantStore.getState().interruption?.trigger).toBe("clear_history");

    await waitFor(() => expect(closeWindow).toBeDefined());
    closeWindow?.();
    await pending;

    expect(useAssistantStore.getState().interruption).toBeNull();
  });
});
