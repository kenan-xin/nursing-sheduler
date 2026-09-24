// @vitest-environment jsdom
//
// The host Preview / confirmation / Apply surface (T07).
//
// Mounted WITHOUT an agent, deliberately. Everything this surface does is the app's:
// if any of it needed a model to be running, that would itself be the defect. So the
// suite drives the real repository, the real adapter and the real cards, and never
// starts a turn.
//
// The claims: the card states host-derived values (not model prose), Apply stays
// closed until every named agreement is confirmed, success is only shown after the
// durable commit, a change underneath the Preview makes it truthfully Out of date,
// and a read-only conversation has no Apply control at all -- not a disabled one.

import "fake-indexeddb/auto";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { proposalScenario } from "@/lib/proposal/test-support";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { assistantProposalCommands, scenarioCommands, useScenarioStore } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import {
  clearTestAuthority,
  installTestAuthority,
  type TestAuthority,
} from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { AssistantReceipts } from "./assistant-receipts";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { useAssistantProposals } from "./use-assistant-proposals";
import {
  AssistantHistoricalConversation,
  AssistantLiveConversation,
} from "./assistant-conversation";

// The two conversation renderings are mounted below to prove which of them carries the
// Preview surface. The library's chat views and the turn session are stubbed for those two
// cases ONLY: the claim under test is the composition -- which rendering mounts the host
// Preview -- and a real transport would add a provider, a core and a network seam to a
// question that has nothing to do with any of them. Every other suite in this file drives
// the real repository, the real adapter and the real cards, untouched.
vi.mock("@copilotkit/react-core/v2", () => ({
  // The view renders its `input` slot, which is where the live rendering docks its cards.
  CopilotChatView: ({ input: Input }: { input?: ComponentType }) => (
    <div data-testid="chat-view-stub">{Input ? <Input /> : null}</div>
  ),
  CopilotChatInput: () => <div data-testid="chat-input-stub" />,
  CopilotChatMessageView: () => <div data-testid="chat-message-view-stub" />,
}));
// The live rendering now also mounts OptimizeRunRequestCard, which reads the router
// through useCapabilityNavigation even when no run was offered (its hook still runs).
vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const sessionSend = vi.hoisted(() => vi.fn(async () => true));
const sessionState = vi.hoisted(() => ({ isRunning: false }));
vi.mock("./use-assistant-session", () => ({
  useAssistantSession: () => ({
    messages: [],
    isRunning: sessionState.isRunning,
    interrupting: false,
    sending: false,
    send: sessionSend,
    stop: vi.fn(),
  }),
}));

/** The two host surfaces, bound to one controller exactly as the panel binds them. */
function HostSurface() {
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} onSend={vi.fn()} disabled={false} />
      <AssistantReceipts controller={controller} />
    </>
  );
}

const SHRINK: AssistantCommandV1[] = [
  { type: "set_roster_range", start: "2026-04-01", end: "2026-04-15", importPublicHolidays: false },
];
const MOVE_LEAVE: AssistantCommandV1[] = [
  { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
];

let harness: TestAuthority;

async function showProposal(commands: AssistantCommandV1[]) {
  const outcome = await assistantProposalCommands.prepare({
    proposalId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    registryStamp: capabilityRegistryStamp(),
    commands,
    rationale: "Shortening the period is what you asked for.",
    evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
    outcome: "untested",
  });
  if (!outcome.ok) throw new Error("fixture proposal was refused");
  assistantActions.showProposal(
    outcome.proposal.proposalId,
    useAssistantStore.getState().turnEpoch,
  );
  return outcome.proposal;
}

beforeEach(async () => {
  sessionState.isRunning = false;
  sessionSend.mockClear();
  assistantActions.resetForTest();
  harness = await installTestAuthority();
  await loadScenario(proposalScenario());
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  clearTestAuthority();
});

describe("the Preview states host-derived facts", () => {
  it("shows before/after values, the cascade, the affected screens and Needs review", async () => {
    await showProposal(SHRINK);
    render(<HostSurface />);

    const card = await screen.findByTestId("assistant-proposal");
    expect(card).toHaveAttribute("data-status", "preview_ready");

    // What the user asked for, with both sides stated.
    const direct = await screen.findByTestId("proposal-direct");
    expect(direct).toHaveTextContent("2026-04-01 to 2026-04-30");
    expect(direct).toHaveTextContent("2026-04-01 to 2026-04-15");

    // The knock-on effect, shown WITH it rather than behind a disclosure.
    const cascade = await screen.findByTestId("proposal-cascade");
    expect(cascade).toHaveTextContent("bo on 29");
    expect(cascade).toHaveTextContent("Removed");

    // The rest waits behind Show details, collapsed by default.
    expect(screen.queryByTestId("proposal-rationale")).toBeNull();
    expect(screen.queryByTestId("proposal-needs-review")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show details" }));

    expect(await screen.findByTestId("proposal-needs-review")).toHaveTextContent(
      "Leave and requests",
    );
    expect(await screen.findByTestId("proposal-screens")).toHaveTextContent("roster-period");

    // The model's words are labelled as reasoning, never as the change itself.
    expect(await screen.findByTestId("proposal-rationale")).toHaveTextContent(
      "Assistant's reasoning",
    );
    // Nothing claims a test that never ran.
    expect(await screen.findByTestId("proposal-outcome")).toHaveTextContent(
      "Not tested by the optimiser",
    );
  });
});

describe("structured confirmations gate Apply", () => {
  it("keeps Apply closed until the named agreement is confirmed, and reopens it on withdrawal", async () => {
    const user = userEvent.setup();
    await showProposal(MOVE_LEAVE);
    render(<HostSurface />);

    const assumption = await screen.findByTestId("proposal-assumption");
    expect(assumption).toHaveTextContent(
      "Has ana agreed to move their leave from 2 Apr to 10 Apr?",
    );
    expect(await screen.findByTestId("proposal-apply")).toBeDisabled();

    await user.click(await screen.findByTestId("assumption-confirm"));
    await waitFor(async () => expect(await screen.findByTestId("proposal-apply")).toBeEnabled());

    // Withdrawing closes it again immediately -- nothing is "almost" agreed.
    await user.click(await screen.findByTestId("assumption-withdraw"));
    await waitFor(async () => expect(await screen.findByTestId("proposal-apply")).toBeDisabled());
  });
});

describe("Apply", () => {
  it("changes nothing until pressed, then shows a receipt with a working Undo", async () => {
    const user = userEvent.setup();
    await showProposal(SHRINK);
    render(<HostSurface />);

    await screen.findByTestId("assistant-proposal");
    // Rendering a Preview is not applying it.
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
    expect(screen.queryByTestId("assistant-receipts")).toBeNull();

    await user.click(await screen.findByTestId("proposal-apply"));

    // Collapsed by default: a slim bar with the newest change's Undo one click away.
    expect(await screen.findByTestId("assistant-receipts")).toHaveTextContent("1 change applied");
    expect(await screen.findByTestId("receipt-undo")).toBeInTheDocument();
    // Success appeared only alongside a real durable commit.
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-15");
    expect(await harness.db.assistantReceipts.count()).toBe(1);
    // The Preview is gone: a settled change is not a live one.
    expect(screen.queryByTestId("assistant-proposal")).toBeNull();

    await user.click(await screen.findByTestId("receipt-undo"));
    await waitFor(() => expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30"));

    // The receipt is KEPT, with an honest state -- the bar's inline Undo shortcut
    // disappears once Undo is no longer available.
    //
    // Waited for, not read once. The store's `rangeEnd` above reverts as soon as the
    // reversal commits, but the receipt's undo standing is derived from a SEPARATE
    // repository read of the reversible top commit, which lands a render later. A
    // one-shot check right after clicking Undo would sample the pre-reversal state
    // whenever that second read had not yet published -- reproducibly so under the
    // full parallel suite, and never in isolation.
    await waitFor(() => expect(screen.queryByTestId("receipt-undo")).toBeNull());

    // Expanding the bar and opening the receipt shows the honest detail: no Undo
    // affordance, and the reason stated instead.
    await user.click(await screen.findByTestId("assistant-receipts-toggle"));
    await user.click(await screen.findByTestId("receipt-row-toggle"));
    const detail = await screen.findByTestId("assistant-receipt");
    expect(detail).not.toHaveAttribute("data-undo", "available");
    expect(await screen.findByTestId("receipt-undo-reason")).toBeInTheDocument();
  });

  it("goes Out of date when the schedule changes underneath it, and refuses to apply", async () => {
    await showProposal(SHRINK);
    render(<HostSurface />);
    await screen.findByTestId("assistant-proposal");

    await scenarioCommands.mutate({ meta: { apiVersion: "alpha", description: "edited" } });

    await waitFor(async () =>
      expect(await screen.findByTestId("assistant-proposal")).toHaveAttribute(
        "data-status",
        "stale",
      ),
    );
    expect(await screen.findByTestId("proposal-stale")).toBeInTheDocument();
    expect(await screen.findByTestId("proposal-apply")).toBeDisabled();
    expect(await screen.findByTestId("proposal-blocks")).toHaveTextContent("out of date");
  });

  it("goes Out of date when the turn is interrupted", async () => {
    await showProposal(SHRINK);
    render(<HostSurface />);
    await screen.findByTestId("assistant-proposal");

    // Stop, a takeover, or a clear all move the turn epoch. The Preview that turn
    // produced is no longer a current, revalidated one.
    await assistantActions.interrupt({ trigger: "stop", threadId: "thread-1", scenarioId: null });

    await waitFor(async () => expect(await screen.findByTestId("proposal-apply")).toBeDisabled());
    expect(await screen.findByTestId("proposal-blocks")).toHaveTextContent("stopped");
  });

  it("blocks on an unsaved editor draft and names it", async () => {
    await showProposal(SHRINK);
    harness.hot.getState().setDraft("shift-type-editor", { id: "Day" });
    render(<HostSurface />);

    expect(await screen.findByTestId("proposal-apply")).toBeDisabled();
    expect(await screen.findByTestId("proposal-blocks")).toHaveTextContent("shift-type-editor");
  });

  // nursing-sheduler-3t8. Apply's trailing refresh used to reread the proposal by the
  // id it closed over, after the active proposal had been cleared -- so the applied
  // proposal came BACK as a Preview ("already applied" + "out of date") whose Revise
  // and Cancel had no active id left to act on and did nothing.
  it("does not bring an applied proposal back as a Preview after Apply settles", async () => {
    const user = userEvent.setup();
    await showProposal(SHRINK);
    render(<HostSurface />);
    await screen.findByTestId("assistant-proposal");

    // Real IndexedDB is slower than the fake one: make the proposal reread lag, so the
    // refresh Apply starts before the cleared state renders also finishes after it.
    const read = assistantProposalCommands.read.bind(assistantProposalCommands);
    vi.spyOn(assistantProposalCommands, "read").mockImplementation(async (id) => {
      const row = await read(id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return row;
    });

    await user.click(await screen.findByTestId("proposal-apply"));
    await screen.findByTestId("assistant-receipts");

    await expect(
      screen.findByTestId("assistant-proposal", undefined, { timeout: 500 }),
    ).rejects.toThrow();
    expect(screen.queryByTestId("proposal-revise")).toBeNull();
    expect(screen.queryByTestId("proposal-cancel")).toBeNull();
  });

  it("shows no Preview for a proposal settled elsewhere while still active", async () => {
    const proposal = await showProposal(SHRINK);
    await assistantProposalCommands.apply({
      proposalId: proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    render(<HostSurface />);

    await screen.findByTestId("assistant-receipts");
    await expect(
      screen.findByTestId("assistant-proposal", undefined, { timeout: 500 }),
    ).rejects.toThrow();
  });

  it("Revise and Cancel still dismiss a stale, unapplied Preview", async () => {
    const user = userEvent.setup();
    for (const button of ["proposal-revise", "proposal-cancel"]) {
      await showProposal(SHRINK);
      const { unmount } = render(<HostSurface />);
      await screen.findByTestId("assistant-proposal");
      await scenarioCommands.mutate({ meta: { apiVersion: "alpha", description: button } });
      await waitFor(async () =>
        expect(await screen.findByTestId("assistant-proposal")).toHaveAttribute(
          "data-status",
          "stale",
        ),
      );

      await user.click(await screen.findByTestId(button));
      await waitFor(() => expect(screen.queryByTestId("assistant-proposal")).toBeNull());
      unmount();
    }
  });

  it("Cancel settles the proposal so it can never be applied", async () => {
    const user = userEvent.setup();
    const proposal = await showProposal(SHRINK);
    render(<HostSurface />);

    await user.click(await screen.findByTestId("proposal-cancel"));
    await waitFor(() => expect(screen.queryByTestId("assistant-proposal")).toBeNull());

    const result = await assistantProposalCommands.apply({
      proposalId: proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(false);
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
  });
});

describe("historical conversations never regain live Apply", () => {
  // WHAT CHANGED (custom-AST ticket 3). This pair used to be asserted by reading
  // `assistant-conversation.tsx` as text, slicing it at `indexOf("export function ...")`
  // and checking which identifiers appeared in each half -- a hand-rolled parser whose
  // slice boundary was a string literal, and which would have reported a clean historical
  // rendering the moment a function was reordered, renamed, or the sentinel comment moved.
  //
  // It is now a DIFFERENTIAL render: both renderings are mounted over the SAME store
  // state, one with a live, preview-ready, applicable proposal sitting in it. The
  // historical rendering shows nothing; the live one shows the Preview and an Apply
  // control. That is causal in the way the text slice was not -- it holds the state fixed
  // and varies only the component, so the difference cannot be an artefact of the fixture.
  it("shows no Preview and no Apply control, with a live proposal in the store", async () => {
    await showProposal(SHRINK);
    render(
      <AssistantHistoricalConversation
        threadId="thread-1"
        reason="This conversation belongs to an earlier schedule."
      />,
    );
    await screen.findByTestId("assistant-historical-conversation");

    // ABSENT, not disabled. There is no control to re-enable.
    expect(screen.queryByTestId("assistant-proposal")).toBeNull();
    expect(screen.queryByTestId("proposal-apply")).toBeNull();
    expect(screen.queryByTestId("assistant-receipts")).toBeNull();
    expect(screen.queryByTestId("apply-navigation-status")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Tell me what to change" })).toBeNull();
  });

  it("mounts the Preview surface in the LIVE rendering, under that same state", async () => {
    await showProposal(SHRINK);
    render(<AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />);

    // The other half of the differential: the state above IS enough to produce a Preview,
    // so the historical rendering's emptiness is a property of the component.
    expect(await screen.findByTestId("assistant-proposal")).toBeInTheDocument();
    expect(await screen.findByTestId("proposal-apply")).toBeInTheDocument();
    expect(screen.getByTestId("apply-navigation-status")).toBeInTheDocument();
  });

  // The follow-up message after an Apply goes through the live rendering's send path.
  it("sends one follow-up after Apply in the LIVE rendering", async () => {
    const user = userEvent.setup();
    sessionSend.mockClear();
    await showProposal(SHRINK);
    render(<AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />);

    await user.click(await screen.findByTestId("proposal-apply"));
    await waitFor(() => expect(sessionSend).toHaveBeenCalledTimes(1));
    expect(sessionSend).toHaveBeenCalledWith(
      "I applied it: Roster period, 2026-04-01 to 2026-04-15.",
    );
  });

  it("sends no follow-up when the Preview is cancelled in the LIVE rendering", async () => {
    const user = userEvent.setup();
    sessionSend.mockClear();
    await showProposal(SHRINK);
    render(<AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />);

    await user.click(await screen.findByTestId("proposal-cancel"));
    await waitFor(() => expect(screen.queryByTestId("assistant-proposal")).toBeNull());
    expect(sessionSend).not.toHaveBeenCalled();
  });

  // The second source read here -- `proposal-preview-card.tsx` must not contain
  // `useFrontendTool`, `renderCustomMessage` or `@copilotkit` -- is retired into mechanisms
  // that make it UNAVAILABLE rather than merely unspelled. Oxlint `no-restricted-imports`
  // closes `@copilotkit/react-core` and `@copilotkit/react-core/v2/headless` whole and
  // restricts every registrant on `@copilotkit/react-core/v2` (including `useFrontendTool`)
  // to three named modules, of which this card is not one -- so it cannot acquire a
  // renderer to register itself as a message. The provider's own prop surface is pinned
  // negatively at COMPILE time in `assistant-copilot-provider.negative.test-d.ts`, which
  // asserts `renderCustomMessages` is absent from its props.
});

// The decision is offered like the option card's answers: Apply, Change something,
// Cancel, and an Other box that talks back to the assistant.
describe("the Preview's decision reads as option-card choices", () => {
  const live = () =>
    render(<AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />);

  it("offers the three choices and the Other box as one group", async () => {
    await showProposal(SHRINK);
    live();

    const decision = await screen.findByRole("group", { name: "Your decision" });
    expect(decision).toContainElement(screen.getByRole("button", { name: /^Apply/ }));
    expect(decision).toContainElement(screen.getByRole("button", { name: /^Change something/ }));
    expect(decision).toContainElement(screen.getByRole("button", { name: /^Cancel/ }));
    expect(decision).toContainElement(
      screen.getByRole("textbox", { name: "Tell me what to change" }),
    );
  });

  it("Change something keeps the proposal revisable and sends nothing", async () => {
    const user = userEvent.setup();
    const proposal = await showProposal(SHRINK);
    live();

    await user.click(await screen.findByRole("button", { name: /^Change something/ }));
    await waitFor(() => expect(screen.queryByTestId("assistant-proposal")).toBeNull());
    expect((await assistantProposalCommands.read(proposal.proposalId))?.status).toBe("stale");
    expect(sessionSend).not.toHaveBeenCalled();
  });

  it("Other sends the text as a user message and marks the Preview for revision", async () => {
    const user = userEvent.setup();
    const proposal = await showProposal(SHRINK);
    live();

    await screen.findByTestId("assistant-proposal");
    // No Send until there is something to send.
    expect(screen.queryByRole("button", { name: "Send what to change" })).toBeNull();
    await user.type(
      screen.getByRole("textbox", { name: "Tell me what to change" }),
      "  Make it end on the 20th  ",
    );
    await user.click(screen.getByRole("button", { name: "Send what to change" }));

    await waitFor(() => expect(sessionSend).toHaveBeenCalledWith("Make it end on the 20th"));
    await waitFor(() => expect(screen.queryByTestId("assistant-proposal")).toBeNull());
    // Revised, not cancelled: the next preparation keeps this proposal's identity.
    expect((await assistantProposalCommands.read(proposal.proposalId))?.status).toBe("stale");
  });

  it("closes Apply and the Other box while a turn is running, leaving the exits open", async () => {
    const user = userEvent.setup();
    sessionState.isRunning = true;
    await showProposal(SHRINK);
    live();

    expect(await screen.findByTestId("proposal-apply")).toBeDisabled();
    const other = screen.getByRole("textbox", { name: "Tell me what to change" });
    expect(other).toBeDisabled();
    await user.type(other, "ignored");
    expect(screen.queryByRole("button", { name: "Send what to change" })).toBeNull();
    expect(screen.getByTestId("proposal-revise")).toBeEnabled();
    expect(screen.getByTestId("proposal-cancel")).toBeEnabled();
  });

  it("Esc on the Preview changes nothing: it only hands focus back", async () => {
    const user = userEvent.setup();
    const proposal = await showProposal(SHRINK);
    live();

    await user.click(await screen.findByTestId("proposal-details-toggle"));
    await user.keyboard("{Escape}");

    expect(screen.getByTestId("assistant-proposal")).toHaveAttribute(
      "data-status",
      "preview_ready",
    );
    expect((await assistantProposalCommands.read(proposal.proposalId))?.status).toBe(
      "preview_ready",
    );
    expect(sessionSend).not.toHaveBeenCalled();
  });

  it("stacks a newer card nearest the composer", async () => {
    await showProposal(SHRINK);
    live();
    const preview = await screen.findByTestId("assistant-proposal");

    act(() =>
      assistantActions.showChoices(
        {
          question: "Which Ana?",
          options: [
            { label: "Ana Lim", detail: "" },
            { label: "Ana Tan", detail: "" },
          ],
          multiple: false,
        },
        useAssistantStore.getState().turnEpoch,
      ),
    );
    const choices = screen.getByTestId("assistant-choices");
    const dock = screen.getByTestId("assistant-card-dock");

    expect(dock).toContainElement(preview);
    expect(dock).toContainElement(choices);
    expect(
      preview.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      dock.compareDocumentPosition(screen.getByTestId("chat-input-stub")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps Apply closed until the agreement is ticked, in the live rendering too", async () => {
    const user = userEvent.setup();
    await showProposal(MOVE_LEAVE);
    live();

    expect(await screen.findByTestId("proposal-apply")).toBeDisabled();
    await user.click(await screen.findByTestId("assumption-confirm"));
    await waitFor(async () => expect(await screen.findByTestId("proposal-apply")).toBeEnabled());
  });
});
