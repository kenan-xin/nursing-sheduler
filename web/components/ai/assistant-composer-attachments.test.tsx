// @vitest-environment jsdom
//
// The live conversation's attachment wiring (2by.10): a composer send carries the queued
// files, an accepted send clears them, a busy refusal keeps them, and a model that
// cannot read images refuses one with the reason. The chat view and the turn session
// are stubbed as in choice-card.test.tsx: the claim is the composition.

import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { assistantActions } from "@/lib/ai/assistant/store";
import { AssistantLiveConversation } from "./assistant-conversation";

const send = vi.hoisted(() => vi.fn());

vi.mock("@copilotkit/react-core/v2", async (importOriginal) => ({
  useAttachments: (await importOriginal<typeof import("@copilotkit/react-core/v2")>())
    .useAttachments,
  CopilotChatView: ({
    onSubmitMessage,
    input: Input,
  }: {
    onSubmitMessage: (value: string) => void;
    input?: ComponentType<{ onSubmitMessage: (value: string) => void }>;
  }) => <div>{Input ? <Input onSubmitMessage={onSubmitMessage} /> : null}</div>,
  CopilotChatInput: ({ onSubmitMessage }: { onSubmitMessage: (value: string) => void }) => (
    <button data-testid="composer-send" onClick={() => onSubmitMessage("what is this?")}>
      composer
    </button>
  ),
  CopilotChatMessageView: () => <div />,
  useFrontendTool: () => {},
  useCopilotKit: () => ({ copilotkit: {} }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-assistant-session", () => ({
  useAssistantSession: () => ({
    messages: [],
    isRunning: false,
    interrupting: false,
    send,
    stop: vi.fn(),
  }),
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function renderLive() {
  render(<AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />);
}
const attach = (file: File) =>
  userEvent.upload(screen.getByTestId("assistant-file-input"), file, { applyAccept: false });

beforeEach(() => {
  send.mockReset();
  assistantActions.resetForTest();
});
afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
});

describe("attachments in the live composer (2by.10)", () => {
  it("sends the queued file with the typed text and clears the queue once accepted", async () => {
    send.mockResolvedValue(true);
    renderLive();
    await attach(new File(["Ana,leave"], "leave.csv", { type: "text/csv" }));
    expect(await screen.findByTestId("assistant-attach-privacy")).toHaveTextContent(
      "Attachments go to OpenRouter with your message",
    );

    await userEvent.click(screen.getByTestId("composer-send"));

    expect(send).toHaveBeenCalledWith("what is this?", {
      attachments: [
        { kind: "text", filename: "leave.csv", mimeType: "text/csv", data: btoa("Ana,leave") },
      ],
    });
    await waitFor(() => expect(screen.queryByTestId("assistant-attach-privacy")).toBeNull());
  });

  it("keeps the queue when the send is refused as busy", async () => {
    send.mockResolvedValue(false);
    renderLive();
    await attach(new File(["notes"], "notes.md", { type: "" }));
    await screen.findByTestId("assistant-attach-privacy");

    await userEvent.click(screen.getByTestId("composer-send"));

    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("assistant-attach-privacy")).toBeInTheDocument();
  });

  it("refuses an image when the model's image support is unknown, and says why", async () => {
    renderLive();
    expect(screen.getByTestId("assistant-file-input")).not.toHaveAttribute(
      "accept",
      expect.stringContaining("image/"),
    );
    await attach(new File([PNG], "ward.png", { type: "image/png" }));

    const line = await screen.findByTestId("assistant-attach-error");
    expect(line).toHaveTextContent(/^This model cannot read images\./);
    expect(line).toHaveAttribute("title", line.textContent);
    expect(screen.queryByTestId("assistant-attach-privacy")).toBeNull();
  });
});
