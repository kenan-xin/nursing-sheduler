// @vitest-environment jsdom
//
// The host diagnostic surface (T10).
//
// Mounted WITHOUT an agent, like the Preview suite and for the same reason: every
// claim this card makes is the app's own. If any of it needed a model to be running,
// that would itself be the defect.
//
// The claims: the card separates VERIFIED copied-run evidence from an untested
// suggestion, refuses to imply a cause, offers an explicit Cancel while a search is
// running, and — once the turn that authorised it has been superseded — reads as
// stopped with no live control rather than as work still in progress.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { proposalScenario } from "@/lib/proposal/test-support";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { assistantProposalCommands } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import {
  clearTestAuthority,
  installTestAuthority,
  type TestAuthority,
} from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import {
  appendSubmittedCandidate,
  candidateEvidenceReference,
  closeSearch,
  openDiagnosticSearch,
  settleCandidate,
  type DiagnosticSearchRecordV1,
} from "@/lib/ai/diagnostic";
import type { ProductOutcomeView } from "@/lib/optimize/outcome-mapping";
import { DiagnosticSearchCard } from "./diagnostic-search-card";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { useAssistantProposals } from "./use-assistant-proposals";

/** The Preview bound to its controller exactly as the panel binds it. */
function PreviewHost() {
  return <ProposalPreviewCard controller={useAssistantProposals()} />;
}

const SHRINK: AssistantCommandV1[] = [
  { type: "set_roster_range", start: "2026-04-01", end: "2026-04-15", importPublicHolidays: false },
];

const NOW = new Date("2026-08-07T12:00:00Z");
const PARENT = "p".repeat(64);

const FEASIBLE: ProductOutcomeView = {
  outcome: "tested-feasible",
  evidence: "feasibility",
  reason: "solved",
};
const STILL_INFEASIBLE: ProductOutcomeView = {
  outcome: "tested-still-infeasible",
  evidence: "infeasibility",
  reason: "infeasibility_proven",
};

function searchWith(outcomes: readonly (ProductOutcomeView | null)[]): DiagnosticSearchRecordV1 {
  let search = openDiagnosticSearch({
    searchId: "search-1",
    scenarioId: "scenario-1",
    threadId: "thread-1",
    turnId: "turn-1",
    parent: { basisId: PARENT, jobId: "job_parent", scenarioId: "scenario-1", documentRevision: 5 },
    turnEpoch: 1,
    leaseEpoch: 1,
    globalGeneration: 0,
    scenarioGeneration: 0,
    compare: false,
    parentExpiresAt: null,
    now: NOW,
  });
  outcomes.forEach((outcome, index) => {
    search = appendSubmittedCandidate(
      search,
      {
        candidateId: `cand-${index}`,
        commands: [],
        commandsDigest: `d${index}`,
        transformDigest: `t${index}`,
        rationale: `fewer people needed on days (idea ${index})`,
        diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
        basisId: `b${index}`,
        inputSha256: `i${index}`,
        parentBasisId: PARENT,
        now: NOW,
      },
      `job-${index}`,
    );
    if (outcome !== null) search = settleCandidate(search, `cand-${index}`, outcome, NOW);
  });
  return search;
}

/** Publish a search under the turn epoch the store is currently on. */
function publish(search: DiagnosticSearchRecordV1, turnEpoch = 0): void {
  assistantActions.publishDiagnostic(search, turnEpoch);
}

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
});

// --- Preview handoff -------------------------------------------------------
//
// The other half of T10's acceptance: a candidate that genuinely tested feasible
// becomes a T07 Preview labelled with the copied run that proved it — and it is
// still the USER who applies it. Driven through the REAL adapter, because the claim
// is about what the durable proposal row carries, not about what this file passes.

describe("handing a tested candidate to the T07 Preview", () => {
  let harness: TestAuthority;

  beforeEach(async () => {
    assistantActions.resetForTest();
    harness = await installTestAuthority();
    await loadScenario(proposalScenario());
  });

  afterEach(() => {
    cleanup();
    clearTestAuthority();
    void harness;
  });

  it("labels the change optimiser-tested and names the copied run as its evidence", async () => {
    const search = closeSearch(searchWith([FEASIBLE]), "first_feasible", null, NOW);
    const candidate = search.candidates[0]!;

    // Exactly what `useDiagnosticTools` prepares once a candidate tests feasible.
    const outcome = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: capabilityRegistryStamp(),
      commands: SHRINK,
      rationale: candidate.rationale ?? "",
      evidence: candidateEvidenceReference(candidate),
      outcome: "optimizer_tested",
    });
    if (!outcome.ok) throw new Error("the tested candidate was refused");
    assistantActions.showProposal(
      outcome.proposal.proposalId,
      useAssistantStore.getState().turnEpoch,
    );

    render(<PreviewHost />);

    // The badge is the claim, and it is only earned by a real tested run.
    expect((await screen.findByTestId("proposal-outcome")).textContent).toBe("Optimiser-tested");
    // The evidence chip points at the CANDIDATE's own basis — the exact copied run.
    expect(await screen.findByTestId("proposal-evidence")).toHaveTextContent(
      "Tested on a copy of this schedule",
    );
    expect(outcome.proposal.evidence[0]).toMatchObject({
      kind: "optimizer_basis",
      reference: candidate.basisId,
    });
    // Still the user's decision: the proposal is offered for review, not applied.
    expect(outcome.proposal.status).toBe("preview_ready");
    expect(outcome.proposal.appliedCommitId ?? null).toBeNull();
  });

  it("never presents an unbound candidate's basis as evidence", () => {
    // A candidate whose identity did not bind was quarantined by the orchestrator
    // and carries no basis id, so there is nothing to cite — and citing the parent
    // instead would attribute the failed run's evidence to the proposed change.
    const search = searchWith([FEASIBLE]);
    const unbound = { ...search.candidates[0]!, basisId: "" };
    expect(candidateEvidenceReference(unbound)).toEqual([]);
  });
});

describe("DiagnosticSearchCard", () => {
  it("renders nothing at all when no search has been published", () => {
    const { container } = render(<DiagnosticSearchCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states that no cause is available, in place of implying one", () => {
    publish(searchWith([FEASIBLE]));
    render(<DiagnosticSearchCard />);

    const note = screen.getByTestId("diagnostic-cause-note").textContent ?? "";
    expect(note).toMatch(/did not give a reason/i);
    expect(note).toMatch(/pressure points worth testing.*not reported causes/i);
    // The single sentence the whole evidence contract turns on.
    expect(note).toMatch(/only proves that exact copy can be solved/i);
  });

  it("separates a verified copied run from the untested idea that suggested it", () => {
    publish(closeSearch(searchWith([FEASIBLE]), "first_feasible", null, NOW));
    render(<DiagnosticSearchCard />);

    const candidate = screen.getByTestId("diagnostic-candidate");
    expect(candidate.dataset.candidateOutcome).toBe("tested-feasible");
    // The suggestion is labelled as a suggestion...
    expect(candidate.textContent).toMatch(/Suggested because:/);
    // ...and the result is labelled as verified, about THIS COPY only.
    expect(candidate.textContent).toMatch(/Verified: solvable on a copy/);
    expect(candidate.textContent).toMatch(/does not prove the change is the only fix/i);
  });

  it("reports a still-infeasible copy as real evidence, not as a failure", () => {
    publish(closeSearch(searchWith([STILL_INFEASIBLE]), "exhausted", null, NOW));
    render(<DiagnosticSearchCard />);

    const candidate = screen.getByTestId("diagnostic-candidate");
    expect(candidate.textContent).toMatch(/Verified: still infeasible on a copy/);
    expect(candidate.textContent).toMatch(/That is real evidence/);
  });

  it("offers an explicit Cancel only while the search is actually running", () => {
    publish(searchWith([null]));
    const { rerender } = render(<DiagnosticSearchCard />);

    expect(screen.getByTestId("diagnostic-running")).toBeTruthy();
    expect(screen.getByTestId("diagnostic-cancel")).toBeTruthy();
    // Truthful about non-pre-emption AND about the reserved ordinary slot: the user
    // is never told their official run is blocked, because it is not.
    const capacity = screen.getByTestId("diagnostic-capacity").textContent ?? "";
    expect(capacity).toMatch(/reserved slot/i);
    expect(capacity).toMatch(/never interrupted automatically/i);

    publish(closeSearch(searchWith([STILL_INFEASIBLE]), "exhausted", null, NOW));
    rerender(<DiagnosticSearchCard />);
    expect(screen.queryByTestId("diagnostic-cancel")).toBeNull();
  });

  it("reads as stopped, with no live control, once its turn has been superseded", () => {
    // A search published under turn epoch 0, then an interruption advances the live
    // epoch. The row is still real history the user watched happen, so it stays on
    // screen -- but it must never keep presenting itself as running work.
    publish(searchWith([null]), 0);
    useAssistantStore.setState({ turnEpoch: 1 });
    render(<DiagnosticSearchCard />);

    expect(screen.getByTestId("assistant-diagnostic").dataset.status).toBe("stopped");
    expect(screen.getByTestId("diagnostic-settled").textContent).toBe("Stopped");
    expect(screen.queryByTestId("diagnostic-cancel")).toBeNull();
    expect(screen.getByTestId("diagnostic-summary").textContent).toMatch(/was stopped/i);
  });
});
