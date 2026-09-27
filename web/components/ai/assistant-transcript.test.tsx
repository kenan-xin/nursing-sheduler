// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { assistantProposalCommands, useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant } from "@/lib/ai/assistant/store";
import { persistThreadMessages, selectActiveThread } from "@/lib/ai/assistant/history-repo";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import type { ReceiptStanding } from "@/lib/store";
import { downloadBlob } from "@/lib/utils/download";
import { AssistantSurface } from "./assistant-surface";

// The panel's own suite (`assistant-panel.test.tsx`) proves the header renders; THIS
// one is about the file the header produces. `downloadBlob` is stubbed so the suite
// can read the Blob it was handed rather than watch jsdom click a synthetic anchor.
vi.mock("@/lib/utils/download", () => ({ downloadBlob: vi.fn() }));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

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
const APP_VERSION = "9.9.9-transcript-test";
const RECEIPT_AT = "2026-08-06T09:30:00.000Z";
// The write transaction stamps `createdAt` from the harness clock, not from the
// caller's context, so every seeded message carries the harness's start instant.
const MESSAGE_AT = "2026-08-06T00:00:00.000Z";

/** One committed receipt, shaped exactly as `describeReceipts` returns it. */
const RECEIPTS: ReceiptStanding[] = [
  {
    receipt: {
      receiptId: "receipt-1",
      schemaVersion: 1,
      proposalId: "proposal-1",
      proposalRevision: 1,
      scenarioId: SCENARIO_ID,
      commitId: "commit-1",
      documentRevision: 13,
      historySessionId: "history-1",
      idempotencyKey: "idem-1",
      commandDigest: "cmd",
      confirmationDigest: "conf",
      registryStamp: { appBuildVersion: APP_VERSION, manifestSha256: "sha" },
      summary: [
        {
          key: "shift-counts:day",
          scope: "shift-counts",
          label: "Day shift cover",
          before: "Nothing",
          after: "2",
          kind: "created",
        },
      ],
      capabilityIds: [],
      createdAt: RECEIPT_AT,
    },
    undo: "available",
    reason: null,
  },
];

let harness: AssistantHarness;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
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

/** Persist a two-turn thread (with one tool call and its result) and open the panel. */
async function seedThread(withMessages: boolean): Promise<void> {
  const thread = await selectActiveThread(SCENARIO_ID, harness.config);
  if (withMessages) {
    await persistThreadMessages(
      [
        { id: "m1", role: "user", content: "why is the 15th short?" },
        {
          id: "m2",
          role: "assistant",
          content: "Let me check the roster.",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "get_schedule_overview", arguments: '{"section":"roster"}' },
            },
          ],
        },
        { id: "m3", role: "tool", content: '{"shifts":3}', toolCallId: "call-1" },
        { id: "m4", role: "assistant", content: "Two nurses are on leave that day." },
      ],
      {
        threadId: thread.threadId,
        scenarioId: SCENARIO_ID,
        modelId: TEST_MODEL,
        turnId: null,
        globalGeneration: 0,
        scenarioGeneration: 0,
        createdAt: MESSAGE_AT,
      },
      harness.config,
    );
  }
  assistantActions.openPanel();
}

async function clickDownload(): Promise<{ text: string; filename: string }> {
  const button = await screen.findByTestId("assistant-download-transcript");
  fireEvent.click(button);
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
  const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
  return { text: await blob.text(), filename };
}

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = APP_VERSION;
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  installFetch();
  setViewport(true);
  await hydrateAssistant();
  useAuthorityStore.setState({
    scenarioId: SCENARIO_ID,
    documentRevision: 12,
    recordRevision: 20,
    ownership: "owner",
  });
  await makeReady();
  vi.mocked(downloadBlob).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_APP_VERSION;
});

describe("the transcript download control", () => {
  it("is absent while the conversation is empty", async () => {
    await seedThread(false);
    render(<AssistantSurface />);

    await screen.findByTestId("assistant-live-conversation");
    expect(screen.queryByTestId("assistant-download-transcript")).not.toBeInTheDocument();
    // The Close control is always there; only the download is gated on content.
    expect(screen.getByTestId("assistant-close")).toBeInTheDocument();
  });

  it("sits in the panel header, immediately left of Close", async () => {
    await seedThread(true);
    render(<AssistantSurface />);

    const button = await screen.findByTestId("assistant-download-transcript");
    expect(button).toHaveAccessibleName("Download transcript");
    // DOM order IS the visual order in this flex row: the next sibling of the
    // download control is the Close control.
    expect(button.nextElementSibling).toBe(screen.getByTestId("assistant-close"));
  });

  it("downloads a Markdown file carrying the version, timestamps, turns and tool summaries", async () => {
    await seedThread(true);
    render(<AssistantSurface />);

    const { text, filename } = await clickDownload();

    // Date-stamped with the wall clock at the click (not the harness clock, which the
    // repository reads share only), so the assertion pins the shape and the agreement
    // between the filename and the stamp inside the file.
    const match = /^schedule-assistant-transcript-(\d{4}-\d{2}-\d{2})\.md$/.exec(filename);
    expect(match).not.toBeNull();
    expect(text).toContain(`Exported: ${match?.[1]}T`);
    expect(text).toContain("# Schedule assistant transcript");
    expect(text).toContain(`App version: ${APP_VERSION}`);
    // Every turn carries its own timestamp.
    expect(text).toContain("## You");
    expect(text).toContain(MESSAGE_AT);
    expect(text).toContain("## Assistant");
    expect(text).toContain("Two nurses are on leave that day.");
    // The tool call and its result are summarised.
    expect(text).toContain("### Tool: get_schedule_overview");
    expect(text).toContain('{"section":"roster"}');
    expect(text).toContain('{"shifts":3}');
  });

  it("includes the receipt summaries an Apply produced", async () => {
    vi.spyOn(assistantProposalCommands, "describeReceipts").mockResolvedValue(RECEIPTS);
    await seedThread(true);
    render(<AssistantSurface />);

    const { text } = await clickDownload();

    expect(text).toContain("## Changes applied");
    expect(text).toContain("Day shift cover");
    expect(text).toContain("Nothing → 2");
  });

  it("never puts the credential in the file", async () => {
    await seedThread(true);
    render(<AssistantSurface />);

    const { text } = await clickDownload();

    // NON-VACUOUS: the same file really did carry the conversation, so an empty or
    // failed build could not pass this by containing nothing.
    expect(text).toContain("Two nurses are on leave that day.");
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).not.toMatch(/sk-or-/);
  });
});
