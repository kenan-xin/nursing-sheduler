// @vitest-environment jsdom
//
// d582 Task 17: Apply of a temporary cover opens Staff, fills the Temporary cover
// form in view and presses its Save, which runs the proposal's one durable Apply.
// Same harness as apply-navigation-staff.integration.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { clearChangeHighlight } from "@/lib/change-highlight/store";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { useModeStore } from "@/lib/mode/mode";
import { assistantProposalCommands, useScenarioStore } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import { clearTestAuthority, installTestAuthority, undoDepth } from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { PeopleTable } from "@/components/people/people-table";
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
  return (
    <>
      <ProposalPreviewCard controller={controller} onSend={() => {}} disabled={false} />
      <ApplyNavigationNotice controller={controller} />
    </>
  );
}

const COVER = { name: "Haseena (Ward 3)", date: "2026-04-10", shiftType: "Day", groups: [] };

async function preview(commands: AssistantCommandV1[]) {
  const prepared = await assistantProposalCommands.prepare({
    proposalId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    registryStamp: capabilityRegistryStamp(),
    commands,
    rationale: "Ward 3 lends Haseena for one Day shift.",
    evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
    outcome: "untested",
  });
  if (!prepared.ok) throw new Error(`fixture proposal was refused: ${JSON.stringify(prepared)}`);
  assistantActions.showProposal(
    prepared.proposal.proposalId,
    useAssistantStore.getState().turnEpoch,
  );
}

async function apply() {
  const user = userEvent.setup();
  const button = await screen.findByTestId("proposal-apply");
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

beforeEach(async () => {
  push.mockClear();
  assistantActions.resetForTest();
  await installTestAuthority();
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

describe("Apply of a temporary cover", () => {
  it("routes to /people, saves through the form as one undo entry, highlights and announces", async () => {
    await loadScenario(proposalScenario());
    await preview([{ type: "add_temporary_cover", ...COVER }]);
    render(
      <>
        <Assistant />
        <PeopleTable />
      </>,
    );
    const base = await undoDepth();

    await apply();

    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/people"));
    await waitFor(() =>
      expect(screen.getByTestId("temporary-cover-status")).toHaveTextContent(
        "Added temporary cover Haseena (Ward 3).",
      ),
    );
    expect(useScenarioStore.getState().temporaryCover).toEqual([COVER]);
    expect(await undoDepth()).toBe(base + 1);
    await waitFor(() =>
      expect(screen.getByTestId("temporary-cover-row-0")).toHaveAttribute(
        "data-change-highlight",
        "true",
      ),
    );
    // The durable Apply ran, so the change list holds its receipt and Undo.
    await waitFor(() => expect(screen.getByTestId("apply-navigation")).toBeInTheDocument());
  });

  it("remove_temporary_cover Apply deletes in the form", async () => {
    await loadScenario({ ...proposalScenario(), temporaryCover: [COVER] });
    await preview([
      { type: "remove_temporary_cover", name: COVER.name, date: COVER.date, shiftType: "Day" },
    ]);
    render(
      <>
        <Assistant />
        <PeopleTable />
      </>,
    );

    await apply();

    await waitFor(() =>
      expect(screen.getByTestId("temporary-cover-status")).toHaveTextContent(
        "Removed temporary cover Haseena (Ward 3).",
      ),
    );
    expect(useScenarioStore.getState().temporaryCover).toEqual([]);
  });
});
