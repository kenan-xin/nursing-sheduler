"use client";

// The HOST controller behind the Preview card, its confirmations, Apply, and the
// receipts it produces (T07).
//
// EVERYTHING HERE IS THE APP'S. The model has no part in it: it cannot enable
// Apply, cannot answer a confirmation, cannot dismiss a block, and cannot see the
// outcome except as ordinary conversation the user chooses to continue. The only
// thing it did was name an operation and a target.
//
// READINESS IS RE-DERIVED, NEVER CACHED. The live basis is reread from PERSISTED
// state -- not from the projection -- whenever anything that could invalidate a
// Preview moves: the scenario identity, either revision, ownership, the turn epoch,
// or an interruption. That is the whole staleness contract in one effect, and it is
// why "Out of date" appears without anyone having to notice and set it.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assistantProposalCommands,
  readConflictingEditorDraft,
  useAuthorityStore,
  type AssistantProposalV1,
  type AssistantScenarioBasis,
  type ReceiptStanding,
} from "@/lib/store";
import {
  describeProposalReadiness,
  type LiveProposalBasis,
  type ProposalDiff,
  type ProposalReadiness,
} from "@/lib/proposal";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";

/** How the last Apply ended, in the terms the host may honestly state. */
export type ApplyOutcomeView =
  | {
      kind: "applied";
      receiptId: string;
      documentRevision: number;
      reloadRequired: boolean;
      /** The Preview's diff. Apply only commits against the basis the Preview was
       *  derived from, so this is what was written, split into direct and cascade
       *  (the receipt's summary merges the two). */
      diff: ProposalDiff;
    }
  | { kind: "failed"; message: string };

export interface AssistantProposalController {
  proposal: AssistantProposalV1 | null;
  readiness: ProposalReadiness | null;
  /** True while the durable Apply transaction is in flight. */
  applying: boolean;
  outcome: ApplyOutcomeView | null;
  receipts: ReceiptStanding[];
  confirm(assumptionId: string): Promise<void>;
  withdraw(assumptionId: string): Promise<void>;
  /** Put the change back to the conversation, keeping it revisable. */
  revise(): Promise<void>;
  cancel(): Promise<void>;
  apply(): Promise<void>;
  undo(receiptId: string): Promise<void>;
  /** Reread the proposal, the receipts and the live basis. */
  refresh(): Promise<void>;
}

/**
 * Why an Apply failed, in a ward manager's words.
 *
 * A repository error code is a fact about the transaction, not a sentence. Mapping
 * it here means the panel never renders an error string that leaked out of storage,
 * and never renders "something went wrong".
 */
function describeApplyFailure(reason: string): string {
  switch (reason) {
    case "not-owner":
      return "This schedule is being edited in another tab, so nothing was applied.";
    case "stale":
      return "The schedule changed while you were reviewing, so nothing was applied. Ask for the change again.";
    case "confirmation-missing":
      return "This change still needs a real-world confirmation, so nothing was applied.";
    case "proposal-conflict":
      return "This change is no longer the one prepared for this schedule, so nothing was applied.";
    case "invalid":
      return "This change no longer fits the schedule, so nothing was applied. Ask for it again.";
    case "fenced":
      return "The conversation was cleared, so nothing was applied.";
    case "history-unavailable":
      return "That step can no longer be reversed.";
    case "reload-required":
      return "An earlier change was saved but the screen is out of step. Reload before applying anything else.";
    default:
      return "Nothing was applied — the change could not be saved. The schedule is unchanged.";
  }
}

export function useAssistantProposals(): AssistantProposalController {
  const active = useAssistantStore((state) => state.activeProposal);
  const liveTurnEpoch = useAssistantStore((state) => state.turnEpoch);
  const interrupting = useAssistantStore((state) => state.interruption !== null);

  const scenarioId = useAuthorityStore((state) => state.scenarioId);
  const documentRevision = useAuthorityStore((state) => state.documentRevision);
  const recordRevision = useAuthorityStore((state) => state.recordRevision);
  const ownership = useAuthorityStore((state) => state.ownership);
  const reloadRequired = useAuthorityStore((state) => state.reloadRequired);

  const [proposal, setProposal] = useState<AssistantProposalV1 | null>(null);
  const [basis, setBasis] = useState<AssistantScenarioBasis | null>(null);
  const [receipts, setReceipts] = useState<ReceiptStanding[]>([]);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<ApplyOutcomeView | null>(null);

  const proposalId = active?.proposalId ?? null;

  const refresh = useCallback(async () => {
    const [nextBasis, nextReceipts] = await Promise.all([
      assistantProposalCommands.readScenarioBasis(),
      assistantProposalCommands.describeReceipts(),
    ]);
    setBasis(nextBasis);
    setReceipts(nextReceipts);
    setProposal(proposalId ? await assistantProposalCommands.read(proposalId) : null);
  }, [proposalId]);

  // The dependency list IS the staleness contract: every value here is one the
  // Preview binds to, so a change to any of them reasks "is this still applicable?"
  // against persisted truth rather than against what this component remembers.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [nextBasis, nextReceipts] = await Promise.all([
        assistantProposalCommands.readScenarioBasis(),
        assistantProposalCommands.describeReceipts(),
      ]);
      const nextProposal = proposalId ? await assistantProposalCommands.read(proposalId) : null;
      if (cancelled) return;
      setBasis(nextBasis);
      setReceipts(nextReceipts);
      setProposal(nextProposal);
    })();
    return () => {
      cancelled = true;
    };
  }, [proposalId, scenarioId, documentRevision, recordRevision, ownership, liveTurnEpoch]);

  const readiness = useMemo<ProposalReadiness | null>(() => {
    if (!proposal) return null;
    const live: LiveProposalBasis = {
      scenarioId: basis?.scenarioId ?? scenarioId,
      documentRevision: basis?.documentRevision ?? documentRevision,
      topCommitId: basis?.topCommitId ?? null,
      leaseEpoch: basis?.leaseEpoch ?? null,
      isOwner: (basis?.isOwner ?? false) && ownership === "owner" && !reloadRequired,
      conflictingDraft: readConflictingEditorDraft(),
      // An interruption that moved the turn epoch past the one this Preview was
      // prepared under has already invalidated it, whether or not it has settled.
      invalidated: interrupting || (active !== null && active.turnEpoch !== liveTurnEpoch),
      registryStamp: capabilityRegistryStamp(),
    };
    return describeProposalReadiness(proposal, live);
  }, [
    proposal,
    basis,
    scenarioId,
    documentRevision,
    ownership,
    reloadRequired,
    interrupting,
    active,
    liveTurnEpoch,
  ]);

  const confirm = useCallback(
    async (assumptionId: string) => {
      if (!proposalId) return;
      await assistantProposalCommands.confirm({ proposalId, assumptionId });
      await refresh();
    },
    [proposalId, refresh],
  );

  const withdraw = useCallback(
    async (assumptionId: string) => {
      if (!proposalId) return;
      await assistantProposalCommands.withdrawConfirmation({ proposalId, assumptionId });
      await refresh();
    },
    [proposalId, refresh],
  );

  /**
   * REVISE and CANCEL are different endings, and the difference is durable.
   *
   * Revise marks the proposal out of date and dismisses the card, but leaves it
   * revisable -- the next preparation in this conversation keeps its identity and
   * moves its revision, which invalidates the answers given against the old one.
   * Cancel is terminal: a cancelled proposal can never be applied, by anything.
   */
  const revise = useCallback(async () => {
    if (proposalId) await assistantProposalCommands.markStale(proposalId);
    assistantActions.clearProposal();
    setOutcome(null);
  }, [proposalId]);

  const cancel = useCallback(async () => {
    if (proposalId) await assistantProposalCommands.cancel(proposalId);
    assistantActions.clearProposal();
    setOutcome(null);
  }, [proposalId]);

  const apply = useCallback(async () => {
    if (!proposalId || !proposal || applying) return;
    setApplying(true);
    setOutcome(null);
    try {
      const result = await assistantProposalCommands.apply({
        proposalId,
        receiptId: crypto.randomUUID(),
      });
      if (result.ok) {
        // SUCCESS IS RENDERED ONLY HERE -- after the durable transaction returned.
        // A publication failure is still a success: the change is saved, and the
        // reload notice says what the user must do about the view.
        setOutcome({
          kind: "applied",
          receiptId: result.receipt.receiptId,
          documentRevision: result.documentRevision,
          reloadRequired: result.reloadRequired,
          diff: proposal.diff,
        });
        assistantActions.clearProposal();
      } else {
        setOutcome({ kind: "failed", message: describeApplyFailure(result.reason) });
      }
    } finally {
      setApplying(false);
      await refresh();
    }
  }, [proposalId, proposal, applying, refresh]);

  const undo = useCallback(
    async (receiptId: string) => {
      await assistantProposalCommands.undoReceipt(receiptId);
      // The reverted receipt is the one the Apply notice is narrating: that claim is
      // no longer true, so drop it rather than leave the notice pointing at a change
      // that no longer exists.
      setOutcome((prev) =>
        prev?.kind === "applied" && prev.receiptId === receiptId ? null : prev,
      );
      await refresh();
    },
    [refresh],
  );

  return {
    proposal,
    readiness,
    applying,
    outcome,
    receipts,
    confirm,
    withdraw,
    revise,
    cancel,
    apply,
    undo,
    refresh,
  };
}
