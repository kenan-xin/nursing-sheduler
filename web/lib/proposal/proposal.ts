// The durable proposal shape and the rules that decide whether Apply may be offered
// (T07, tech-plan "Domain commands and Preview" / "Apply transaction and receipt").
//
// A PROPOSAL IS A BINDING, not a suggestion. It records the exact basis it was
// prepared against -- scenario identity, document revision, top commit, lease epoch,
// command digest, registry stamp -- so "is this still the change the user reviewed?"
// is a comparison rather than a judgement. Every invalidation the flows require
// (edit, regenerate, scenario/revision/lease/target change, interruption, takeover)
// is one of those comparisons failing.
//
// READINESS IS DERIVED, NEVER STORED. A stored "ready" flag can only ever describe
// the moment it was written; a derivation cannot be stale. `describeProposalReadiness`
// is therefore the single answer to "may Apply run?", asked by the Preview on every
// render, by the Apply handler before it starts, and by the durable transaction
// again from persisted state.

import type { CapabilityRegistryStamp } from "@/lib/capability/types";
import type { AssistantCommandV1 } from "./commands";
import { ASSISTANT_COMMAND_SCHEMA_VERSION } from "./commands";
import {
  outstandingAssumptions,
  type OperationalAssumption,
  type OperationalConfirmationV1,
} from "./assumptions";
import { confirmationsDigest } from "./assumptions";
import { proposalDigest } from "./digest";
import type { ProposalDiff } from "./diff";

/**
 * The proposal lifecycle.
 *
 * These literals are duplicated by `AssistantProposalStatus` in the repository's DTO
 * module, which this layer may not import (authority boundary). The projection
 * adapter imports both and asserts their assignability, so a divergence is a compile
 * error there rather than a runtime surprise.
 */
export type ProposalStatus =
  | "preview_ready"
  | "confirmation_required"
  | "stale"
  | "applied"
  | "cancelled"
  | "failed";

/** Whether the change has been tested against the solver. T10 supplies the tested case. */
export type ProposalOutcome = "untested" | "optimizer_tested" | "inconclusive";

/**
 * A TYPED reference to why the assistant proposed this.
 *
 * Never a URL and never free text pretending to be a citation: `reference` is an
 * app-owned identity (an Optimize basis id, a capability id) or `null` for evidence
 * that is simply what the user said.
 */
export interface EvidenceReference {
  kind: "user_statement" | "existing_scenario" | "optimizer_basis" | "capability";
  /** What the Preview shows on the evidence chip. */
  label: string;
  reference: string | null;
}

/** A proposal as it is persisted and as the Preview renders it. */
export interface PreparedProposalV1 {
  proposalId: string;
  schemaVersion: 1;
  /** Which command-union version the `commands` were parsed under. */
  commandSchemaVersion: typeof ASSISTANT_COMMAND_SCHEMA_VERSION;
  /**
   * Increments on every re-preparation under the same proposal id. Confirmations
   * bind to it, which is what makes Revise/regenerate clear them without anybody
   * having to remember to.
   */
  revision: number;

  scenarioId: string;
  threadId: string | null;
  turnId: string | null;
  /** The basis. All four are compared before Apply. */
  baseDocumentRevision: number;
  baseCommitId: string | null;
  leaseEpoch: number;
  registryStamp: CapabilityRegistryStamp;

  commands: AssistantCommandV1[];
  commandsDigest: string;
  /** Non-authoritative model text. Never a source of authority, never an action. */
  rationale: string | null;
  evidence: EvidenceReference[];
  outcome: ProposalOutcome;

  diff: ProposalDiff;
  assumptions: OperationalAssumption[];
  confirmations: OperationalConfirmationV1[];

  status: ProposalStatus;
  globalGeneration: number;
  scenarioGeneration: number;
  createdAt: string;
  updatedAt: string;
}

/** The digest that answers “is this the same change?”. */
export function commandsDigest(commands: readonly AssistantCommandV1[]): string {
  return proposalDigest({ schemaVersion: ASSISTANT_COMMAND_SCHEMA_VERSION, commands });
}

/** What the host currently knows, read from persisted state, not the projection's memory. */
export interface LiveProposalBasis {
  scenarioId: string | null;
  documentRevision: number;
  topCommitId: string | null;
  leaseEpoch: number | null;
  isOwner: boolean;
  /** A named unsaved editor draft over the same document, or `null`. */
  conflictingDraft: string | null;
  /** An interruption, takeover or clear has invalidated in-flight assistant work. */
  invalidated: boolean;
  registryStamp: CapabilityRegistryStamp;
}

/** Why Apply is not available. Each one is a comparison that failed. */
export type ProposalBlock =
  | { code: "settled"; message: string }
  | { code: "not_owner"; message: string }
  | { code: "scenario_changed"; message: string }
  | { code: "document_changed"; message: string }
  | { code: "lease_changed"; message: string }
  | { code: "interrupted"; message: string }
  | { code: "conflicting_draft"; message: string }
  | { code: "registry_changed"; message: string }
  | { code: "confirmation_required"; message: string; outstanding: OperationalAssumption[] };

export interface ProposalReadiness {
  /** The status the proposal should be shown (and persisted) as right now. */
  status: ProposalStatus;
  applyEnabled: boolean;
  blocks: ProposalBlock[];
  outstanding: OperationalAssumption[];
}

/**
 * Whether this proposal may still be applied against `live`, and if not, why.
 *
 * Order matters only for readability -- every block is collected, because a Preview
 * that reveals one reason at a time makes a user fix things one round trip at a
 * time. STALENESS is checked before confirmation: asking someone to re-confirm an
 * agreement for a change that can no longer be applied would be worse than useless.
 */
export function describeProposalReadiness(
  proposal: PreparedProposalV1,
  live: LiveProposalBasis,
): ProposalReadiness {
  const blocks: ProposalBlock[] = [];

  if (proposal.status === "applied" || proposal.status === "cancelled") {
    blocks.push({
      code: "settled",
      message:
        proposal.status === "applied"
          ? "This change has already been applied."
          : "This change was cancelled.",
    });
  }
  if (live.invalidated) {
    blocks.push({
      code: "interrupted",
      message: "This change was stopped, so it has to be prepared again.",
    });
  }
  if (!live.isOwner) {
    blocks.push({
      code: "not_owner",
      message: "This schedule is being edited in another tab, so nothing can be applied here.",
    });
  }
  if (live.scenarioId !== proposal.scenarioId) {
    blocks.push({
      code: "scenario_changed",
      message: "A different schedule is open now, so this change no longer applies.",
    });
  } else if (
    live.documentRevision !== proposal.baseDocumentRevision ||
    (proposal.baseCommitId !== null && live.topCommitId !== proposal.baseCommitId)
  ) {
    // BOTH are compared. The revision catches an ordinary edit; the commit id also
    // catches an Undo-then-redo path that arrives back at the same revision number
    // through different content.
    blocks.push({
      code: "document_changed",
      message: "This schedule changed after the change was prepared, so it is out of date.",
    });
  }
  if (live.leaseEpoch !== null && live.leaseEpoch !== proposal.leaseEpoch) {
    blocks.push({
      code: "lease_changed",
      message: "Editing was taken over, so this change has to be prepared again.",
    });
  }
  if (live.conflictingDraft) {
    blocks.push({
      code: "conflicting_draft",
      message: `Save or discard the open ${live.conflictingDraft} first — it changes the same schedule.`,
    });
  }
  if (
    live.registryStamp.appBuildVersion !== proposal.registryStamp.appBuildVersion ||
    live.registryStamp.manifestSha256 !== proposal.registryStamp.manifestSha256
  ) {
    blocks.push({
      code: "registry_changed",
      message:
        "The app was updated after this change was prepared, so it has to be prepared again.",
    });
  }

  const outstanding = outstandingAssumptions(
    proposal.assumptions,
    proposal.confirmations,
    proposal.revision,
  );
  const stale = blocks.length > 0;
  if (!stale && outstanding.length > 0) {
    blocks.push({
      code: "confirmation_required",
      message: "Confirm the real-world arrangements below before applying.",
      outstanding,
    });
  }

  const status: ProposalStatus =
    proposal.status === "applied" || proposal.status === "cancelled" || proposal.status === "failed"
      ? proposal.status
      : stale
        ? "stale"
        : outstanding.length > 0
          ? "confirmation_required"
          : "preview_ready";

  return { status, applyEnabled: blocks.length === 0, blocks, outstanding };
}

/**
 * The idempotency key one Apply consumes.
 *
 * Every input that would make this a DIFFERENT Apply is in it: the proposal and its
 * revision, the exact commands, the exact confirmations, and the exact basis. A
 * retry after a lost acknowledgement therefore reproduces the key and replays the
 * original commit; anything the user actually changed produces a new key, and the
 * repository's unique index refuses to let one key stand for two different commits.
 */
export function deriveIdempotencyKey(proposal: PreparedProposalV1): string {
  return proposalDigest({
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    commandsDigest: proposal.commandsDigest,
    confirmationsDigest: confirmationsDigest(
      proposal.confirmations.filter(
        (confirmation) => confirmation.proposalRevision === proposal.revision,
      ),
    ),
    scenarioId: proposal.scenarioId,
    baseDocumentRevision: proposal.baseDocumentRevision,
    baseCommitId: proposal.baseCommitId,
    leaseEpoch: proposal.leaseEpoch,
  });
}
