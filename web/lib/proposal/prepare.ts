// Preparing a proposal (T07) -- the one function that turns validated commands into
// the reviewable change set, and the one place a Preview's contents come from.
//
// PURE. It takes the document and the basis as arguments and returns a value; it
// reads no store and writes no table. That is what lets the projection adapter run
// it against the PERSISTED envelope (rather than the projection) at prepare time,
// and run it AGAIN against the freshly-read envelope at Apply time, and be sure the
// two agree for the same inputs.
//
// A REVISION IS A NEW AGREEMENT. `reviseProposal` bumps the revision and starts with
// no confirmations at all -- not because the old answers are hard to carry, but
// because they were given about a different change. Carrying them would be the
// mechanism by which "they agreed to move Ana's leave to the 4th" quietly became
// authorisation for moving it to the 6th.

import type { ScenarioUiState } from "@/lib/scenario";
import type { CapabilityRegistryStamp } from "@/lib/capability/types";
import { ASSISTANT_COMMAND_SCHEMA_VERSION, type AssistantCommandV1 } from "./commands";
import { deriveAssumptions } from "./assumptions";
import { deriveProposalDiff } from "./diff";
import { applyAssistantCommands, type CommandRejection } from "./operations";
import { newRuleClash, ruleClashMessage } from "@/lib/rules/shortfalls";
import {
  commandsDigest,
  type EvidenceReference,
  type PreparedProposalV1,
  type ProposalOutcome,
} from "./proposal";

export interface PrepareProposalInput {
  proposalId: string;
  /** 1 for a first preparation; `reviseProposal` supplies the rest. */
  revision: number;
  scenarioId: string;
  threadId: string | null;
  turnId: string | null;
  /** The PERSISTED document, read in the same pass as the revision below it. */
  document: ScenarioUiState;
  baseDocumentRevision: number;
  baseCommitId: string | null;
  leaseEpoch: number;
  registryStamp: CapabilityRegistryStamp;
  commands: readonly AssistantCommandV1[];
  rationale: string | null;
  evidence: readonly EvidenceReference[];
  outcome: ProposalOutcome;
  globalGeneration: number;
  scenarioGeneration: number;
  now: Date;
}

export type PrepareProposalResult =
  | {
      ok: true;
      proposal: PreparedProposalV1;
      /** The document Apply will produce. Recomputed durably; never persisted here. */
      next: ScenarioUiState;
    }
  | { ok: false; rejection: CommandRejection };

export function prepareProposal(input: PrepareProposalInput): PrepareProposalResult {
  if (input.commands.length === 0) {
    return {
      ok: false,
      rejection: { index: 0, code: "no_effect", message: "That change contains nothing to do." },
    };
  }

  const applied = applyAssistantCommands(input.document, input.commands);
  if (!applied.ok) return { ok: false, rejection: applied.rejection };

  // A change no roster could ever meet (two rules each letting only their own people
  // work one shift) is refused here, so no Preview offers it (bead att).
  const clash = newRuleClash(input.document, applied.next);
  if (clash) {
    return {
      ok: false,
      rejection: {
        index: 0,
        code: "invalid_value",
        message: ruleClashMessage(applied.next, clash),
      },
    };
  }

  const diff = deriveProposalDiff(input.document, applied.next, input.commands);
  if (diff.direct.length === 0 && diff.cascade.length === 0) {
    // Every arm reported a change, yet the documents are identical. Rather than
    // render an empty Preview with a live Apply button -- which reads as a change the
    // user made -- refuse, so the assistant has to say what it actually found.
    return {
      ok: false,
      rejection: {
        index: 0,
        code: "no_effect",
        message: "That would leave the schedule exactly as it is.",
      },
    };
  }

  const timestamp = input.now.toISOString();
  const assumptions = deriveAssumptions(input.document, applied.next, input.commands);

  return {
    ok: true,
    next: applied.next,
    proposal: {
      proposalId: input.proposalId,
      schemaVersion: 1,
      commandSchemaVersion: ASSISTANT_COMMAND_SCHEMA_VERSION,
      revision: input.revision,
      scenarioId: input.scenarioId,
      threadId: input.threadId,
      turnId: input.turnId,
      baseDocumentRevision: input.baseDocumentRevision,
      baseCommitId: input.baseCommitId,
      leaseEpoch: input.leaseEpoch,
      registryStamp: input.registryStamp,
      commands: [...input.commands],
      commandsDigest: commandsDigest(input.commands),
      rationale: input.rationale,
      evidence: [...input.evidence],
      outcome: input.outcome,
      diff,
      assumptions,
      confirmations: [],
      status: assumptions.length > 0 ? "confirmation_required" : "preview_ready",
      globalGeneration: input.globalGeneration,
      scenarioGeneration: input.scenarioGeneration,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

/**
 * Re-prepare an existing proposal against current state -- Revise, regenerate, or a
 * recovery from Out of date.
 *
 * The identity is kept so the conversation still refers to one change; the revision
 * moves, which invalidates every confirmation and every idempotency key derived from
 * the previous one.
 */
export function reviseProposal(
  previous: PreparedProposalV1,
  input: Omit<PrepareProposalInput, "proposalId" | "revision">,
): PrepareProposalResult {
  return prepareProposal({
    ...input,
    proposalId: previous.proposalId,
    revision: previous.revision + 1,
  });
}
