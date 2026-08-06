"use client";

// T10 — the bounded infeasibility-diagnostics tool.
//
// THE MODEL PROPOSES; THE HOST TESTS. The payload is the same typed command subset
// T07 already validates, grouped into at most five candidates. Every candidate is
// applied by HOST code to an immutable copy, serialized through the exact T08 path,
// given its own basis bound to the failed run's parent, and submitted under the T09
// diagnostic purpose. Nothing the model writes reaches the solver unvalidated, and
// no argument it can phrase names a document, a patch, or a job id.
//
// THE PARENT IS NEVER AN ARGUMENT. Which failed run to diagnose is read from this
// browser's own durable basis rows for the CURRENT scenario revision. A tool that
// accepted a job id could be pointed at another tab's run, at a run for a different
// schedule, or at one that never happened — and the whole evidence chain hangs off
// getting that binding right.
//
// EVIDENCE IS NOT A CLAIM. A tested-feasible candidate hands off to a T07 Preview
// carrying `optimizer_tested` and the candidate's basis id as a typed evidence
// reference. It is still the USER who applies it, still under the current lease and
// revision, and a successful Apply still never starts an official Optimize run.

import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { assistantCommandListSchema, type AssistantCommandV1 } from "@/lib/proposal";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { assistantProposalCommands, readAuthoritativeScenarioIdentity } from "@/lib/store";
import { getScenarioAuthority } from "@/lib/store/spine";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import {
  MAX_DIAGNOSTIC_CANDIDATES,
  candidateEvidenceReference,
  explainSearchSummary,
} from "@/lib/ai/diagnostic";
import { runDiagnosticSearchForTurn } from "@/lib/ai/diagnostic/diagnostic-runtime";

/** What a handler answers once its turn is no longer the current one. */
const SUPERSEDED = "superseded: this request belongs to an interrupted turn and was not answered.";

const candidateSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe(
      "Why you think this change might make the schedule solvable, in one plain " +
        "sentence. This is a hypothesis, not a finding — say so in your own words.",
    ),
  operations: assistantCommandListSchema.describe(
    "The supported operations that make up ONE candidate change to test.",
  ),
});

const diagnosticParameters = z.object({
  candidates: z
    .array(candidateSchema)
    .min(1)
    .max(MAX_DIAGNOSTIC_CANDIDATES)
    .describe(
      `Up to ${MAX_DIAGNOSTIC_CANDIDATES} candidate changes to test, most promising ` +
        "first. They are tested ONE AT A TIME, in this order.",
    ),
  compare: z
    .boolean()
    .default(false)
    .describe(
      "Only set this true when the user explicitly asked to compare options. " +
        "Otherwise testing stops at the first change that produces a solvable copy.",
    ),
});

/**
 * Register the diagnostics tool against ONE agent instance.
 *
 * `turnEpoch` is the AUTHORISED epoch, exactly as the other tools take it. A search
 * is long-running work with many awaits in it, so the epoch is re-checked before the
 * search opens, inside it (via `isTurnActive`), and again before anything is
 * published — a Preview raised into an interrupted turn would be a live Apply
 * control for a conversation the user already stopped.
 */
export function useDiagnosticTools(agentId: string, turnEpoch: number): void {
  useFrontendTool(
    {
      name: "test_feasibility_candidates",
      agentId,
      description:
        "Test candidate changes against the solver on COPIES of the schedule, to find " +
        "one that makes an infeasible schedule solvable. Use this only after an " +
        "Optimize run has proved the current schedule infeasible. Nothing is changed: " +
        "each candidate is applied to a copy and solved separately, and at most " +
        `${MAX_DIAGNOSTIC_CANDIDATES} candidates are tested, one at a time. A solvable ` +
        "copy proves only that exact copy can be solved — it never proves why the " +
        "original failed, and you must not present it as a cause.",
      parameters: diagnosticParameters,
      handler: async (args, context) => {
        if (context.signal?.aborted) return SUPERSEDED;
        if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;

        const parent = await readDiagnosticParent();
        if (parent === null) {
          return (
            "There is no retained Optimize run for the schedule as it stands now that this " +
            "tab can diagnose, so there is nothing to test. Tell the user to run Optimize on " +
            "the current schedule from this tab first, and to come back if it comes out " +
            "infeasible."
          );
        }

        if (context.signal?.aborted) return SUPERSEDED;
        if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;

        const result = await runDiagnosticSearchForTurn({
          searchId: crypto.randomUUID(),
          threadId: null,
          turnId: useAssistantStore.getState().activeTurnId,
          turnEpoch,
          leaseEpoch: parent.leaseEpoch,
          compare: args.compare,
          parent: {
            basisId: parent.basisId,
            jobId: parent.jobId,
            scenarioId: parent.scenarioId,
            documentRevision: parent.documentRevision,
          },
          parentExpiresAt: parent.expiresAt,
          scenarioId: parent.scenarioId,
          proposed: args.candidates.map((candidate, index) => ({
            candidateId: `${index}-${crypto.randomUUID()}`,
            commands: candidate.operations as AssistantCommandV1[],
            rationale: candidate.summary,
          })),
          isTurnActive: (epoch) => useAssistantStore.getState().turnEpoch === epoch,
          publish: (search) => assistantActions.publishDiagnostic(search, turnEpoch),
        });

        // RE-CHECKED AFTER THE SEARCH. It is the longest-running thing the assistant
        // does, so this is the await that most needs the gate.
        if (context.signal?.aborted) return SUPERSEDED;
        if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;

        const summary = explainSearchSummary(result.search);
        const candidate = result.previewCandidate;
        if (candidate === null) {
          return (
            `${summary} Tell the user this in your own words. Do not claim a cause, and do ` +
            "not describe an untested idea as though it had been tested."
          );
        }

        // The tested candidate becomes a Preview the USER may apply. The outcome is
        // `optimizer_tested` and the evidence is the candidate's own basis id, so the
        // card can show exactly which copied run backs the change.
        const live = useAssistantStore.getState().activeProposal;
        const outcome = await assistantProposalCommands.prepare({
          proposalId: crypto.randomUUID(),
          ...(live ? { previousProposalId: live.proposalId } : {}),
          threadId: null,
          turnId: useAssistantStore.getState().activeTurnId,
          registryStamp: capabilityRegistryStamp(),
          commands: candidate.commands,
          rationale: candidate.rationale ?? summary,
          evidence: candidateEvidenceReference(candidate),
          outcome: "optimizer_tested",
        });

        if (context.signal?.aborted) return SUPERSEDED;
        if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;

        if (!outcome.ok) {
          return (
            `${summary} The tested change could not be prepared for review just now, and ` +
            "nothing was altered. Tell the user what was tested and suggest they try again."
          );
        }

        assistantActions.showProposal(outcome.proposal.proposalId, turnEpoch);
        return (
          `${summary} The tested change is now shown to the user as a preview, labelled with ` +
          "the copied run that proved it. Nothing has changed yet, and you cannot apply it — " +
          "only the user can. Do not say the change has been made, and do not say it explains " +
          "why the original failed."
        );
      },
    },
    [agentId, turnEpoch],
  );
}

/**
 * The failed ordinary run this browser may diagnose, or `null`.
 *
 * Host-derived end to end: the CURRENT persisted scenario identity, then this
 * browser's own most recent ordinary basis for that exact revision. Whether that run
 * is actually trustworthy is not decided here — the orchestrator's open gate
 * classifies recovery and refuses anything but a trusted, current basis.
 */
async function readDiagnosticParent(): Promise<{
  basisId: string;
  jobId: string;
  scenarioId: string;
  documentRevision: number;
  leaseEpoch: number;
  expiresAt: string | null;
} | null> {
  const identity = await readAuthoritativeScenarioIdentity();
  if (identity === null) return null;
  // The lease epoch is recorded on the search row so a later write can be told apart
  // from one made under a lease this tab has since lost. A tab that does not own the
  // scenario has no epoch, and diagnosing under someone else's lease would produce
  // evidence for a Preview that could never be applied here anyway.
  const scenarioBasis = await assistantProposalCommands.readScenarioBasis();
  if (scenarioBasis === null || scenarioBasis.leaseEpoch === null) return null;

  const basis = await getScenarioAuthority().readLatestOrdinaryBasis(
    identity.scenarioId,
    identity.documentRevision,
  );
  if (basis === null || basis.jobId === null) return null;
  return {
    basisId: basis.basisId,
    jobId: basis.jobId,
    scenarioId: identity.scenarioId,
    documentRevision: identity.documentRevision,
    leaseEpoch: scenarioBasis.leaseEpoch,
    expiresAt: basis.expiresAt,
  };
}
