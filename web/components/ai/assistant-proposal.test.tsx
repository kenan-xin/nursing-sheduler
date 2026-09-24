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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  CopilotChatView: () => <div data-testid="chat-view-stub" />,
  CopilotChatMessageView: () => <div data-testid="chat-message-view-stub" />,
}));
// The live rendering now also mounts OptimizeRunRequestCard, which reads the router
// through useCapabilityNavigation even when no run was offered (its hook still runs).
vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-assistant-session", () => ({
  useAssistantSession: () => ({
    messages: [],
    isRunning: false,
    interrupting: false,
    send: vi.fn(),
    stop: vi.fn(),
  }),
}));

/** The two host surfaces, bound to one controller exactly as the panel binds them. */
function HostSurface() {
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} />
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
  assistantActions.resetForTest();
  harness = await installTestAuthority();
  await loadScenario(proposalScenario());
});

afterEach(() => {
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
    expect(assumption).toHaveTextContent("Has ana agreed to move their leave from 02 to 10?");
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
    expect(screen.queryByTestId("assistant-receipt")).toBeNull();

    await user.click(await screen.findByTestId("proposal-apply"));

    const receipt = await screen.findByTestId("assistant-receipt");
    expect(receipt).toHaveAttribute("data-undo", "available");
    expect(receipt).toHaveTextContent("Undo available");
    // Success appeared only alongside a real durable commit.
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-15");
    expect(await harness.db.assistantReceipts.count()).toBe(1);
    // The Preview is gone: a settled change is not a live one.
    expect(screen.queryByTestId("assistant-proposal")).toBeNull();

    await user.click(await screen.findByTestId("receipt-undo"));
    await waitFor(() => expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30"));

    // The receipt is KEPT, with an honest state and no Undo affordance.
    //
    // Waited for, not read once. The store's `rangeEnd` above reverts as soon as the
    // reversal commits, but the receipt's `data-undo` is derived from a SEPARATE
    // repository read of the reversible top commit, which lands a render later. A
    // one-shot `getAttribute` right after `findByTestId` therefore sampled the
    // pre-reversal attribute whenever that second read had not yet published --
    // reproducibly so under the full parallel suite, and never in isolation.
    await waitFor(async () => {
      const settled = await screen.findByTestId("assistant-receipt");
      expect(settled.getAttribute("data-undo")).not.toBe("available");
    });
    expect(screen.queryByTestId("receipt-undo")).toBeNull();
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
    expect(screen.queryByTestId("assistant-receipt")).toBeNull();
    expect(screen.queryByTestId("apply-navigation-status")).toBeNull();
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
