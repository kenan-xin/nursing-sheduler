// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant } from "@/lib/ai/assistant/store";
import {
  persistThreadMessages,
  recordPreparingTurn,
  selectActiveThread,
} from "@/lib/ai/assistant/history-repo";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import { AssistantLauncher } from "./assistant-launcher";
import { AssistantSurface } from "./assistant-surface";
import { ASSISTANT_DOCK_MIN_WIDTH, ASSISTANT_DOCK_WIDTH_KEY } from "./assistant-panel";

// The library's scroll-anchoring uses ResizeObserver, which jsdom does not
// implement. Stubbed locally rather than in the shared setup file: this is the only
// suite that renders the chat primitives, and a global stub would quietly make
// ResizeObserver "work" for every other component test too.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/**
 * Drive the dock/sheet pivot. The panel asks `matchMedia` once and then listens, so
 * the suite can render either container deterministically instead of depending on a
 * jsdom viewport width it does not really have.
 */
function setViewport(wide: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: wide,
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

/**
 * Every network call the mounted assistant makes is recorded here. The suite's
 * central claim is about what this list DOES NOT contain.
 */
function installFetch() {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/api/copilotkit")) {
      return new Response(
        JSON.stringify({
          agents: { scheduler: { description: "Scheduler" } },
          mode: "sse",
          runtimeInstanceId: "instance-1",
          telemetryDisabled: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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

function seedAuthority(ownership: "owner" | "read-only") {
  useAuthorityStore.setState({
    scenarioId: SCENARIO_ID,
    documentRevision: 12,
    recordRevision: 20,
    ownership,
  });
}

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  installFetch();
  setViewport(true);
  await hydrateAssistant();
  seedAuthority("owner");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("discoverability while not Ready", () => {
  it("renders no launcher and no panel while AI is off", () => {
    const { container } = render(
      <>
        <AssistantLauncher />
        <AssistantSurface />
      </>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(requested).toEqual([]);
  });

  it("renders no launcher while enabled but not yet probed", async () => {
    await assistantActions.setEnabled(true);
    render(<AssistantLauncher />);

    expect(screen.queryByTestId("assistant-launcher")).not.toBeInTheDocument();
  });

  it("hides the launcher again the moment the key is removed", async () => {
    await makeReady();
    render(<AssistantLauncher />);
    expect(screen.getByTestId("assistant-launcher")).toBeInTheDocument();

    await assistantActions.removeKey();

    await waitFor(() => expect(screen.queryByTestId("assistant-launcher")).not.toBeInTheDocument());
  });
});

describe("mounting reserves nothing and contacts no provider", () => {
  it("renders nothing while Ready but closed -- no reserved panel space", async () => {
    await makeReady();

    const { container } = render(<AssistantSurface />);

    expect(container).toBeEmptyDOMElement();
    expect(requested).toEqual([]);
  });

  it("opening the panel starts no run and reaches no third party", async () => {
    await makeReady();
    render(<AssistantSurface />);
    assistantActions.openPanel();

    await waitFor(() => expect(screen.getByTestId("assistant-dock")).toBeInTheDocument());

    // The same-origin handshake is allowed; a provider request is not.
    for (const url of requested) {
      expect(url).not.toContain("openrouter.ai");
      expect(url).not.toContain("/agent/run");
    }
    expect(requested.every((url) => url.includes("/api/copilotkit"))).toBe(true);
  });
});

describe("the responsive dock and sheet", () => {
  beforeEach(async () => {
    await makeReady();
    assistantActions.openPanel();
  });

  it("docks beside the screen on a wide layout", async () => {
    render(<AssistantSurface />);

    const dock = await screen.findByTestId("assistant-dock");
    expect(screen.queryByTestId("assistant-sheet")).not.toBeInTheDocument();
    // A shrink-0 sibling column: the screen narrows beside it rather than being
    // covered by it.
    expect(dock.className).toContain("shrink-0");
    expect(dock).toHaveAttribute("aria-label", "Schedule assistant");
  });

  it("opens as a sheet over the app on a narrow layout", async () => {
    setViewport(false);
    render(<AssistantSurface />);

    const sheet = await screen.findByTestId("assistant-sheet");
    expect(screen.queryByTestId("assistant-dock")).not.toBeInTheDocument();
    expect(sheet.querySelector('[role="dialog"]')).toHaveAttribute("aria-modal", "true");
    // Exactly one close control, not one per mechanism: the scrim is a pointer
    // convenience and is aria-hidden.
    expect(screen.getByRole("button", { name: "Close assistant" })).toHaveAttribute(
      "data-testid",
      "assistant-close",
    );
  });

  it("mounts exactly ONE conversation, so one thread has one agent", async () => {
    render(<AssistantSurface />);
    await screen.findByTestId("assistant-live-conversation");

    // Two simultaneous thread-scoped agents under one thread id collide in
    // CopilotKit's registry, which is why the body renders once rather than twice
    // behind CSS visibility.
    expect(screen.getAllByTestId("assistant-live-conversation")).toHaveLength(1);
  });

  it("identifies the schedule and the model in use, following the prototype header", async () => {
    render(<AssistantSurface />);

    expect(await screen.findByTestId("assistant-panel-subtitle")).toHaveTextContent(TEST_MODEL);
  });

  it("exposes NO Apply, Preview or confirmation surface -- the prototype's immediate-Apply is overridden", async () => {
    const { container } = render(<AssistantSurface />);
    await screen.findByTestId("assistant-dock");

    for (const forbidden of [/\bapply\b/i, /\bpreview\b/i, /\bconfirm\b/i, /proposed fix/i]) {
      expect(container.textContent ?? "").not.toMatch(forbidden);
    }
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
  });

  it("presents the app's own welcome content, and states nothing changes without the user's say-so", async () => {
    render(<AssistantSurface />);

    const welcome = await screen.findAllByTestId("assistant-welcome");
    expect(welcome[0]).toHaveTextContent(/nothing changes until you say so/i);
  });

  it("never renders the credential", async () => {
    const { container } = render(<AssistantSurface />);
    await screen.findByTestId("assistant-dock");

    expect(container.innerHTML).not.toContain(SENTINEL_KEY);
  });
});

describe("the resizable dock", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await makeReady();
    assistantActions.openPanel();
  });

  it("keeps the shipped w-96 default until the user drags", async () => {
    render(<AssistantSurface />);

    const dock = await screen.findByTestId("assistant-dock");
    expect(dock.className).toContain("w-96");
    expect(dock.style.width).toBe("");
  });

  it("exposes a keyboard separator that widens, clamps and persists", async () => {
    window.localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "400");
    render(<AssistantSurface />);

    const dock = await screen.findByTestId("assistant-dock");
    const handle = screen.getByRole("separator", { name: "Resize assistant" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuenow", "400");
    expect(dock.style.width).toBe("400px");

    // The handle sits on the dock's LEFT edge, so ArrowLeft grows the panel.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(dock.style.width).toBe("416px");
    expect(window.localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("416");

    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", String(ASSISTANT_DOCK_MIN_WIDTH));
  });

  it("follows a pointer drag on the inner edge", async () => {
    window.localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "400");
    render(<AssistantSurface />);

    const dock = await screen.findByTestId("assistant-dock");
    const handle = screen.getByRole("separator", { name: "Resize assistant" });
    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 500 });
    fireEvent.pointerUp(window, { clientX: 500 });

    expect(dock.style.width).toBe("500px");
    expect(window.localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("500");
  });

  it("shows no handle on the narrow sheet", async () => {
    setViewport(false);
    render(<AssistantSurface />);

    await screen.findByTestId("assistant-sheet");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});

describe("reload restores local history", () => {
  it("hydrates the live conversation from canonical records, with no run and no replay", async () => {
    await makeReady();
    const thread = await selectActiveThread(SCENARIO_ID, harness.config);
    await persistThreadMessages(
      [
        { id: "m1", role: "user", content: "why is the 15th short?" },
        { id: "m2", role: "assistant", content: "Two nurses are on leave that day." },
      ],
      {
        threadId: thread.threadId,
        scenarioId: SCENARIO_ID,
        modelId: TEST_MODEL,
        turnId: null,
        globalGeneration: 0,
        scenarioGeneration: 0,
        createdAt: harness.now().toISOString(),
      },
      harness.config,
    );
    assistantActions.openPanel();

    render(<AssistantSurface />);

    // This is the post-reload state: the runtime holds nothing for this thread, and
    // the transcript comes back from IndexedDB alone.
    await waitFor(() => {
      expect(screen.getAllByTestId("assistant-live-conversation")[0]).toHaveTextContent(
        "why is the 15th short?",
      );
    });
    // The assistant turn renders through the library's markdown path, a tick behind
    // the plain user bubble.
    await waitFor(() => {
      expect(screen.getByTestId("assistant-live-conversation")).toHaveTextContent(
        "Two nurses are on leave that day.",
      );
    });
    // Restored history is not a resumed run: nothing reconnected, and no provider
    // request was made to "continue" the turn.
    for (const url of requested) {
      expect(url).not.toContain("/agent/run");
      expect(url).not.toContain("/agent/connect");
      expect(url).not.toContain("openrouter.ai");
    }
  });

  it("settles a turn stranded by the previous page lifetime as detached", async () => {
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
        runtimeInstanceId: "a-previous-launch",
      },
      harness.config,
    );

    await hydrateAssistant();

    const settled = await harness.db.assistantTurns.get(turn?.turnId ?? "");
    expect(settled?.state).toBe("detached");
    // A LOCAL settlement class, never a synthesised provider completion.
    expect(settled?.terminalReason).toBe("detached_reload");
  });
});

describe("a read-only tab", () => {
  it("renders history with no input and no live handlers", async () => {
    await makeReady();
    const thread = await selectActiveThread(SCENARIO_ID, harness.config);
    await persistThreadMessages(
      [{ id: "m1", role: "user", content: "why is the 15th short?" }],
      {
        threadId: thread.threadId,
        scenarioId: SCENARIO_ID,
        modelId: TEST_MODEL,
        turnId: null,
        globalGeneration: 0,
        scenarioGeneration: 0,
        createdAt: harness.now().toISOString(),
      },
      harness.config,
    );
    seedAuthority("read-only");
    assistantActions.openPanel();

    render(<AssistantSurface />);

    const historical = await screen.findAllByTestId("assistant-historical-conversation");
    expect(historical[0]).toHaveTextContent(/edited in another tab/i);
    // The live conversation — the only thing that mounts an agent, its tools and an
    // input — is absent entirely.
    expect(screen.queryByTestId("assistant-live-conversation")).not.toBeInTheDocument();
    await waitFor(() => expect(historical[0]).toHaveTextContent("why is the 15th short?"));
    expect(historical[0].querySelector("textarea")).toBeNull();
  });
});
