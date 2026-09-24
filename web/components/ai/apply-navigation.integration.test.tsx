// @vitest-environment jsdom
//
// Apply → navigate → highlight, with nothing faked but the router and toasts.
// The router commits its URL LATE, like a real App Router transition. The
// destination is mounted from the start (the shipped mount path is covered by the
// notice's own unit tests), so what this proves is the real prepare → Apply →
// guarded navigate → diff-driven highlight path end to end, including that a late
// URL commit does not stop the highlight from landing, and that undoing the applied
// receipt clears the notice and the highlight.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { CAPABILITY_ANCHOR_ATTRIBUTE } from "@/lib/capability/anchor-contract";
import { clearChangeHighlight } from "@/lib/change-highlight/store";
import { proposalScenario } from "@/lib/proposal/test-support";
import { useModeStore } from "@/lib/mode/mode";
import { assistantProposalCommands } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import { clearTestAuthority, installTestAuthority } from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { ShiftTypeGrid } from "@/components/shift-types/shift-type-grid";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { ApplyNavigationNotice } from "./apply-navigation-notice";
import { useAssistantProposals } from "./use-assistant-proposals";

const push = vi.fn((path: string) => {
  setTimeout(() => window.history.replaceState({}, "", path), 20);
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => window.location.pathname,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function Assistant() {
  const controller = useAssistantProposals();
  const { outcome } = controller;
  return (
    <>
      <ProposalPreviewCard controller={controller} onSend={() => {}} disabled={false} />
      <ApplyNavigationNotice controller={controller} />
      {outcome?.kind === "applied" ? (
        <button
          data-testid="test-undo-receipt"
          onClick={() => void controller.undo(outcome.receiptId)}
        >
          Undo
        </button>
      ) : null}
    </>
  );
}

beforeEach(async () => {
  push.mockClear();
  assistantActions.resetForTest();
  await installTestAuthority();
  await loadScenario(proposalScenario());
  useModeStore.setState({ mode: "guided", adoption: "ready" });
  window.history.replaceState({}, "", "/dates");
});

afterEach(() => {
  cleanup();
  clearTestAuthority();
  clearChangeHighlight();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
  window.history.replaceState({}, "", "/");
});

describe("Apply → navigate → highlight", () => {
  it("opens Shift types, outlines the new card, announces it, and leaves focus alone", async () => {
    const user = userEvent.setup();
    const prepared = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: capabilityRegistryStamp(),
      commands: [
        {
          type: "add_shift_type",
          code: "EVE",
          name: "Evening",
          startTime: "14:00",
          endTime: "22:00",
          restMinutes: 0,
        },
      ],
      rationale: "You asked for an evening shift.",
      evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
      outcome: "untested",
    });
    if (!prepared.ok) throw new Error("fixture proposal was refused");
    assistantActions.showProposal(
      prepared.proposal.proposalId,
      useAssistantStore.getState().turnEpoch,
    );

    render(
      <>
        <Assistant />
        <ShiftTypeGrid />
      </>,
    );

    const apply = await screen.findByTestId("proposal-apply");
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);

    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/shift-types"));
    const card = await screen.findByTestId("shift-card-string:EVE");
    await waitFor(() => expect(card).toHaveAttribute("data-change-highlight", "true"));
    expect(screen.getByTestId("shift-card-string:Day")).not.toHaveAttribute(
      "data-change-highlight",
    );
    expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
      "Opened Shift types. 1 shift type added.",
    );
    // Apply does not move focus onto the Shifts screen's Add button.
    expect(document.activeElement?.getAttribute(CAPABILITY_ANCHOR_ATTRIBUTE)).not.toBe(
      "shift-types.add-shift-type",
    );

    // Undo reverts the receipt: the notice stops claiming a change that no longer
    // exists, and the highlight it was pointing at goes with it.
    await user.click(screen.getByTestId("test-undo-receipt"));
    await waitFor(() => expect(screen.queryByTestId("apply-navigation")).toBeNull());
    // Undo reverted the creation itself, so the card -- and its highlight -- is gone.
    await waitFor(() => expect(screen.queryByTestId("shift-card-string:EVE")).toBeNull());
  });
});
