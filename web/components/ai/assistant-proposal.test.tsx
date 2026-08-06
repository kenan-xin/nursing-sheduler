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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const settled = await screen.findByTestId("assistant-receipt");
    expect(settled.getAttribute("data-undo")).not.toBe("available");
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
  // Asserted at the SOURCE rather than by rendering, and that is the stronger claim:
  // rendering shows that one historical thread had no Apply button, while this shows
  // that the read-only component has no Apply control to re-enable under any
  // circumstances -- it does not mount the host Preview surface, does not construct
  // the proposal controller, and does not register the prepare tool.
  const source = readFileSync(join(__dirname, "assistant-conversation.tsx"), "utf8");

  it("mounts the Preview surface in the LIVE rendering only", () => {
    const historical = source.slice(
      source.indexOf("export function AssistantHistoricalConversation"),
    );
    expect(historical).not.toContain("ProposalPreviewCard");
    expect(historical).not.toContain("AssistantReceipts");
    expect(historical).not.toContain("useAssistantProposals");

    const live = source.slice(
      source.indexOf("export function AssistantLiveConversation"),
      source.indexOf("export interface AssistantHistoricalConversationProps"),
    );
    expect(live).toContain("ProposalPreviewCard");
    expect(live).toContain("useAssistantProposals");
  });

  it("keeps the Preview out of the message transcript entirely", () => {
    // A message is a record of something that was said. If the card were rendered
    // as one, a reloaded transcript would carry a live control back with it.
    const cards = readFileSync(join(__dirname, "proposal-preview-card.tsx"), "utf8");
    expect(cards).not.toContain("useFrontendTool");
    expect(cards).not.toContain("renderCustomMessage");
    expect(cards).not.toContain("@copilotkit");
  });
});
