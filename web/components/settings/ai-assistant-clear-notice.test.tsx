// @vitest-environment jsdom
//
// The SHIPPED Settings surface for a clear that did not complete.
//
// Every case here drives the real card through the DOM, because that is where the
// defects this round is about actually live: a retry that follows the current
// selection instead of the one the notice belongs to, a control that re-enables while
// the deletion's own post-processing is still running, a second click that starts a
// second deletion, and a rejection that escapes as an unhandled promise instead of a
// re-enabled button.
//
// THE ASSERTIONS ARE ON THE CALL, not on a downstream side effect. "The database ended
// up empty" is true for the wrong scenario too; "clearHistory was called once, with
// scenario A and the tombstone A belongs to, and clearAll was never called" is not.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * A gate on the OUTCOME-RETIREMENT step, which runs after the interruption has
 * settled. Holding it is how "the button stays disabled until the whole promise
 * settles" is distinguished from "the button is disabled while an interruption is in
 * flight" -- the two are indistinguishable if the clear is only held earlier.
 */
const gate = vi.hoisted(() => ({
  held: null as null | Promise<void>,
  /** Runs just before retirement, to interleave a concurrent write. */
  before: null as null | (() => Promise<void>),
  calls: 0,
}));

vi.mock("@/lib/ai/assistant/clear-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/assistant/clear-repo")>();
  return {
    ...actual,
    clearOutcomes: async (
      scope: Parameters<typeof actual.clearOutcomes>[0],
      scenarioId: Parameters<typeof actual.clearOutcomes>[1],
      config?: Parameters<typeof actual.clearOutcomes>[2],
    ) => {
      gate.calls += 1;
      if (gate.before) await gate.before();
      if (gate.held) await gate.held;
      return actual.clearOutcomes(scope, scenarioId, config);
    },
  };
});

import {
  assistantActions,
  hydrateAssistant,
  useAssistantStore,
  type ClearActionResult,
} from "@/lib/ai/assistant/store";
import { persistClearFacts } from "@/lib/ai/assistant/clear-repo";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import { useAuthorityStore } from "@/lib/store";
import { AiAssistantCard } from "./ai-assistant-card";

const SCENARIO_A = "scenario-a";
const SCENARIO_B = "scenario-b";
const OP_A = "op-scenario-a-0001";

let harness: AssistantHarness;

function catalogResponse(): Response {
  return new Response(
    JSON.stringify({
      source: "catalog",
      fallbackVersion: 1,
      models: [{ id: TEST_MODEL, name: "Claude Sonnet 4.5", contextLength: 200000 }],
      recommendedId: TEST_MODEL,
    }),
    { status: 200 },
  );
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiAssistantCard />
    </QueryClientProvider>,
  );
}

/** A resolved `deleted` result, for spies that stand in for the real action. */
function deletedResult(scenarioId: string): ClearActionResult {
  return {
    requestId: "request-stub",
    operationId: "operation-stub",
    scope: "history",
    scenarioId,
    status: "deleted",
    reason: null,
    settlement: "completed",
    deletionOutcome: "deleted",
    configurationOutcome: "retained",
  };
}

/** Seed a durable terminal record, in the canonical shape the product writes. */
function seedOutcome(input: {
  operationId: string;
  scenarioId: string | null;
  status: "incomplete" | "failed";
  scope?: "history" | "all";
  now?: () => Date;
}) {
  return persistClearFacts(
    {
      requestId: `request-${input.operationId}`,
      operationId: input.operationId,
      scope: input.scope ?? "history",
      scenarioId: input.scenarioId,
      status: input.status,
      reason: input.status === "failed" ? "storage" : "superseded",
      settlement: input.status === "failed" ? null : "stopped",
      deletionOutcome: input.status === "failed" ? null : "superseded",
      configurationOutcome: "retained",
    },
    input.now ? { now: input.now } : {},
  );
}

/** The store projection a persisted history tombstone produces. */
function historyNotice(status: "incomplete" | "failed", operationId: string | null = OP_A) {
  return {
    status,
    scope: "history" as const,
    scenarioId: SCENARIO_A,
    reason: "superseded" as const,
    configurationOutcome: "retained" as const,
    operationId,
  };
}

beforeEach(async () => {
  gate.held = null;
  gate.before = null;
  gate.calls = 0;
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/ai/openrouter/models")) return catalogResponse();
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as unknown as typeof fetch;
  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  useAuthorityStore.setState({ scenarioId: SCENARIO_A, documentRevision: 1 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the notice for a clear that did not complete", () => {
  it.each(["incomplete", "failed"] as const)(
    "names Clear all exactly for a %s global clear",
    async (status) => {
      useAssistantStore.setState({
        clearResult: {
          status,
          scope: "all",
          scenarioId: null,
          reason: status === "failed" ? "storage" : "recapture_exhausted",
          configurationOutcome: "deleted",
          operationId: "op-all-0001",
        },
      });
      renderCard();

      const notice = screen.getByTestId("ai-clear-incomplete");
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice).toHaveTextContent("Some AI data could not be cleared");
      expect(notice).toHaveTextContent("Your API key was removed");
      expect(screen.getByTestId("ai-clear-retry")).toHaveTextContent("Try clearing again");
      // The scoped copy must not leak into the global notice.
      expect(notice).not.toHaveTextContent("History was not cleared");
    },
  );

  it.each(["incomplete", "failed"] as const)(
    "names Clear history exactly for a %s scoped clear",
    async (status) => {
      useAssistantStore.setState({ clearResult: historyNotice(status) });
      renderCard();

      const notice = screen.getByTestId("ai-clear-incomplete");
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice).toHaveTextContent("History was not cleared");
      expect(notice).toHaveTextContent("Newer conversations were kept");
      expect(screen.getByTestId("ai-clear-retry")).toHaveTextContent("Try clearing history again");
      // A scoped failure must never present itself as a global one.
      expect(notice).not.toHaveTextContent("Some AI data could not be cleared");
      expect(notice).not.toHaveTextContent("Your API key was removed");
    },
  );

  it.each(["incomplete", "failed"] as const)(
    "says the key was KEPT for a %s global clear that never reached its fence",
    async (status) => {
      // The clear failed before `beginClear` committed, so the credential is still
      // here. Saying it was removed would be false, and would send the user off to
      // re-enter a key they still have.
      useAssistantStore.setState({
        clearResult: {
          status,
          scope: "all",
          scenarioId: null,
          reason: status === "failed" ? "storage" : "recapture_exhausted",
          configurationOutcome: "retained",
          operationId: "op-all-retained",
        },
      });
      renderCard();

      const notice = screen.getByTestId("ai-clear-incomplete");
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice).toHaveTextContent("Some AI data could not be cleared");
      expect(notice).toHaveTextContent(
        "Your API key and settings were kept, but the clear did not finish.",
      );
      // THE FALSE CLAIM MUST BE ABSENT, not merely de-emphasised.
      expect(notice).not.toHaveTextContent("Your API key was removed");
      // The action is still offered: retrying a clear that never started is safe.
      expect(screen.getByTestId("ai-clear-retry")).toHaveTextContent("Try clearing again");
    },
  );

  it("offers no action when a global clear cannot say what it did", async () => {
    useAssistantStore.setState({
      clearResult: {
        status: "failed",
        scope: "all",
        scenarioId: null,
        reason: "storage",
        configurationOutcome: "unknown",
        operationId: "op-all-unknown",
      },
    });
    renderCard();

    const notice = screen.getByTestId("ai-clear-incomplete");
    expect(notice).toHaveTextContent("Local AI data could not be read");
    expect(notice).toHaveTextContent("could not confirm the current AI data state");
    // Neither claim is made, and nothing destructive is offered.
    expect(notice).not.toHaveTextContent("Your API key was removed");
    expect(notice).not.toHaveTextContent("Your API key and settings were kept");
    expect(screen.queryByTestId("ai-clear-retry")).not.toBeInTheDocument();
  });

  it("never claims key removal on a history notice", async () => {
    useAssistantStore.setState({ clearResult: historyNotice("failed") });
    renderCard();

    const notice = screen.getByTestId("ai-clear-incomplete");
    expect(notice).toHaveTextContent("History was not cleared");
    // A scoped clear says nothing about the credential either way -- it never touches
    // it. ("Newer conversations were kept" is the history copy's own, and correct.)
    expect(notice).not.toHaveTextContent("Your API key was removed");
    expect(notice).not.toHaveTextContent("Your API key and settings were kept");
  });

  it("offers no action at all when storage failed before a scope was known", async () => {
    // `scope: null` is the absence of a scope, not a scope. Rendering a retry here
    // would pick one on the user's behalf, and the only one wide enough to be safe is
    // the one that deletes everything.
    useAssistantStore.setState({
      clearResult: {
        status: "failed",
        scope: null,
        scenarioId: null,
        reason: "storage",
        configurationOutcome: "unknown",
        operationId: null,
      },
    });
    renderCard();

    const notice = screen.getByTestId("ai-clear-incomplete");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice).toHaveTextContent("Local AI data could not be read");
    expect(notice).toHaveTextContent("could not confirm the current AI data state");
    // NO DESTRUCTIVE ACTION, and neither scope's copy.
    expect(screen.queryByTestId("ai-clear-retry")).not.toBeInTheDocument();
    expect(notice).not.toHaveTextContent("Some AI data could not be cleared");
    expect(notice).not.toHaveTextContent("History was not cleared");
  });

  it("shows nothing at all after a successful clear", async () => {
    useAssistantStore.setState({ clearResult: null });
    renderCard();
    expect(screen.queryByTestId("ai-clear-incomplete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-clear-retry")).not.toBeInTheDocument();
  });
});

describe("the history retry, bound to its captured scenario", () => {
  it("clears the notice's scenario after the selection changes and then becomes null", async () => {
    // The persisted outcome belongs to A. The user then moves to B, and finally to no
    // schedule at all -- the exact sequence that used to redirect or disable the retry.
    useAssistantStore.setState({ clearResult: historyNotice("incomplete") });
    useAuthorityStore.setState({ scenarioId: SCENARIO_B });
    const history = vi
      .spyOn(assistantActions, "clearHistory")
      .mockResolvedValue(deletedResult(SCENARIO_A));
    const all = vi.spyOn(assistantActions, "clearAll");

    const user = userEvent.setup();
    renderCard();
    act(() => {
      useAuthorityStore.setState({ scenarioId: null });
    });

    const retry = screen.getByTestId("ai-clear-retry");
    // Still available with nothing selected: the identity it needs is the captured one.
    expect(retry).toBeEnabled();
    await user.click(retry);

    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    // THE CAUSAL ASSERTION. Scenario A, and the operation the notice was rendered from.
    expect(history).toHaveBeenCalledWith(
      { threadId: null, scenarioId: SCENARIO_A },
      { retryOfOperationId: OP_A },
    );
    // A scoped retry may never widen to the global action.
    expect(all).not.toHaveBeenCalled();
  });

  it("survives a reload and retries the tombstone's own operation identity", async () => {
    const operationId = await seedOutcome({
      operationId: "op-durable-0001",
      scenarioId: SCENARIO_A,
      status: "incomplete",
    });
    expect(operationId).toBe("op-durable-0001");

    // SIMULATE RELOAD: a fresh store, rehydrated from durable state alone.
    assistantActions.resetForTest();
    await hydrateAssistant();
    expect(useAssistantStore.getState().clearResult).toMatchObject({
      status: "incomplete",
      scope: "history",
      scenarioId: SCENARIO_A,
      operationId: "op-durable-0001",
    });

    const history = vi
      .spyOn(assistantActions, "clearHistory")
      .mockResolvedValue(deletedResult(SCENARIO_A));
    const all = vi.spyOn(assistantActions, "clearAll");
    // A reloaded page lands on whatever schedule is open now, which is not the one the
    // tombstone belongs to.
    useAuthorityStore.setState({ scenarioId: SCENARIO_B });
    const user = userEvent.setup();
    renderCard();

    expect(screen.getByTestId("ai-clear-incomplete")).toHaveTextContent("History was not cleared");
    await user.click(screen.getByTestId("ai-clear-retry"));

    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    expect(history).toHaveBeenCalledWith(
      { threadId: null, scenarioId: SCENARIO_A },
      { retryOfOperationId: "op-durable-0001" },
    );
    expect(all).not.toHaveBeenCalled();
  });

  it("survives unmount and remount without losing its captured identity", async () => {
    useAssistantStore.setState({ clearResult: historyNotice("failed") });
    const first = renderCard();
    expect(screen.getByTestId("ai-clear-incomplete")).toHaveTextContent("History was not cleared");

    first.unmount();
    expect(screen.queryByTestId("ai-clear-incomplete")).not.toBeInTheDocument();
    // The remount happens under a different schedule, so a retry that read the current
    // selection would clear the wrong conversation.
    useAuthorityStore.setState({ scenarioId: SCENARIO_B });

    const history = vi
      .spyOn(assistantActions, "clearHistory")
      .mockResolvedValue(deletedResult(SCENARIO_A));
    const all = vi.spyOn(assistantActions, "clearAll");
    const user = userEvent.setup();
    renderCard();

    expect(screen.getByTestId("ai-clear-incomplete")).toHaveTextContent("History was not cleared");
    await user.click(screen.getByTestId("ai-clear-retry"));

    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    expect(history).toHaveBeenCalledWith(
      { threadId: null, scenarioId: SCENARIO_A },
      { retryOfOperationId: OP_A },
    );
    expect(all).not.toHaveBeenCalled();
  });

  it("retries a global notice with the global action and no scenario identity", async () => {
    useAssistantStore.setState({
      clearResult: {
        status: "incomplete",
        scope: "all",
        scenarioId: null,
        reason: "recapture_exhausted",
        configurationOutcome: "deleted",
        operationId: "op-all-0001",
      },
    });
    const history = vi.spyOn(assistantActions, "clearHistory");
    const all = vi.spyOn(assistantActions, "clearAll").mockResolvedValue({
      ...deletedResult(SCENARIO_A),
      scope: "all",
      scenarioId: null,
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId("ai-clear-retry"));

    await waitFor(() => expect(all).toHaveBeenCalledTimes(1));
    expect(history).not.toHaveBeenCalled();
  });
});

describe("the pending state of a clear in progress", () => {
  it("stays disabled until the whole promise, including outcome settlement, resolves", async () => {
    await selectActiveThread(SCENARIO_A);
    let release!: () => void;
    gate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByTestId("ai-clear-history"));
    await user.click(screen.getByTestId("ai-clear-confirm-yes"));

    // Held INSIDE outcome retirement, which runs after the interruption has settled.
    await waitFor(() => expect(gate.calls).toBe(1));
    // NON-VACUITY: the interruption is already over, so the disabled state below is the
    // clear's own pending state and not the interruption's.
    expect(useAssistantStore.getState().interruption).toBeNull();
    expect(screen.getByTestId("ai-clear-history")).toBeDisabled();
    expect(screen.getByTestId("ai-clear-all")).toBeDisabled();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("ai-clear-all")).toBeEnabled());
    expect(screen.getByTestId("ai-clear-history")).toBeEnabled();
  });

  it("suppresses a duplicate click while the first clear is still running", async () => {
    useAssistantStore.setState({ clearResult: historyNotice("incomplete") });
    let release!: (value: ClearActionResult) => void;
    const history = vi.spyOn(assistantActions, "clearHistory").mockImplementation(
      () =>
        new Promise<ClearActionResult>((resolve) => {
          release = resolve;
        }),
    );
    const all = vi.spyOn(assistantActions, "clearAll");
    renderCard();

    const retry = screen.getByTestId("ai-clear-retry");
    // TWO CLICKS INSIDE ONE BATCH, dispatched natively so React has not re-rendered
    // between them. Only the synchronous guard can refuse the second.
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(history).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ai-clear-retry")).toBeDisabled();

    await act(async () => {
      release(deletedResult(SCENARIO_A));
      await Promise.resolve();
    });
    expect(history).toHaveBeenCalledTimes(1);
    expect(all).not.toHaveBeenCalled();
  });

  it("contains a rejected clear instead of leaking an unhandled rejection", async () => {
    useAssistantStore.setState({ clearResult: historyNotice("failed") });
    const leaked: unknown[] = [];
    const onWindow = (event: PromiseRejectionEvent) => {
      leaked.push(event.reason);
      event.preventDefault();
    };
    const onProcess = (reason: unknown) => leaked.push(reason);
    window.addEventListener("unhandledrejection", onWindow);
    process.on("unhandledRejection", onProcess);

    const history = vi
      .spyOn(assistantActions, "clearHistory")
      .mockRejectedValue(new Error("storage went away"));
    const all = vi.spyOn(assistantActions, "clearAll");

    try {
      const user = userEvent.setup();
      renderCard();
      await user.click(screen.getByTestId("ai-clear-retry"));

      await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
      // The control comes back rather than staying stuck behind a lost promise.
      await waitFor(() => expect(screen.getByTestId("ai-clear-retry")).toBeEnabled());
      // Let any rejection that escaped reach the handlers above.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(leaked).toEqual([]);
      expect(all).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    }
  });
});

describe("the real action behind the notice", () => {
  it("retires a stale predecessor tombstone on an ordinary successful clear", async () => {
    await selectActiveThread(SCENARIO_A);
    // Left over from an earlier page lifetime, for this scenario...
    await seedOutcome({
      operationId: "op-stale-0001",
      scenarioId: SCENARIO_A,
      status: "incomplete",
    });
    // ...and for a different one, which this clear has no authority over at all.
    await seedOutcome({
      operationId: "op-other-scenario-0001",
      scenarioId: SCENARIO_B,
      status: "failed",
    });

    const user = userEvent.setup();
    renderCard();
    // The ORDINARY path, not a retry: no operation identity is handed in, so only the
    // set captured before the fence can retire anything.
    await user.click(screen.getByTestId("ai-clear-history"));
    await user.click(screen.getByTestId("ai-clear-confirm-yes"));

    await waitFor(() => expect(gate.calls).toBe(1));
    await waitFor(async () =>
      expect(await harness.db.assistantClearOperations.get("op-stale-0001")).toBeUndefined(),
    );
    expect(await harness.db.assistantClearOperations.get("op-other-scenario-0001")).toBeDefined();
  });

  it("does not resurrect a retired notice on the next reload", async () => {
    await selectActiveThread(SCENARIO_A);
    await seedOutcome({
      operationId: "op-stale-0002",
      scenarioId: SCENARIO_A,
      status: "incomplete",
    });
    assistantActions.resetForTest();
    await hydrateAssistant();
    // NON-VACUITY: the stale tombstone really does project a notice before the clear.
    expect(useAssistantStore.getState().clearResult?.operationId).toBe("op-stale-0002");

    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByTestId("ai-clear-history"));
    await user.click(screen.getByTestId("ai-clear-confirm-yes"));
    await waitFor(() => expect(useAssistantStore.getState().clearResult).toBeNull());

    assistantActions.resetForTest();
    await hydrateAssistant();
    expect(useAssistantStore.getState().clearResult).toBeNull();
  });

  it("retires only the tombstone the user retried, and never touches Clear all", async () => {
    await selectActiveThread(SCENARIO_A);
    // The tombstone the notice belongs to — the only thing this retry owns.
    expect(
      await seedOutcome({
        operationId: "op-retried-0001",
        scenarioId: SCENARIO_A,
        status: "incomplete",
      }),
    ).toBe("op-retried-0001");

    // A CONCURRENT tombstone for the same scenario, written while this clear is in its
    // post-deletion work — a queued call, or another tab. It is stamped a second in the
    // PAST deliberately: a time cutoff alone would happily sweep it, so only the
    // captured-identity set can save it.
    gate.before = async () => {
      await seedOutcome({
        operationId: "op-concurrent-0001",
        scenarioId: SCENARIO_A,
        status: "failed",
        now: () => new Date(Date.now() - 1_000),
      });
    };

    useAssistantStore.setState({ clearResult: historyNotice("incomplete", "op-retried-0001") });
    const all = vi.spyOn(assistantActions, "clearAll");
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId("ai-clear-retry"));
    await waitFor(() => expect(useAssistantStore.getState().clearResult).toBeNull());
    expect(gate.calls).toBe(1);

    // The retried tombstone is gone; the concurrent one survives byte for byte.
    expect(await harness.db.assistantClearOperations.get("op-retried-0001")).toBeUndefined();
    expect(await harness.db.assistantClearOperations.get("op-concurrent-0001")).toMatchObject({
      operationId: "op-concurrent-0001",
      scope: "history",
      scenarioId: SCENARIO_A,
      outcome: "failed",
    });
    expect(all).not.toHaveBeenCalled();
  });
});
