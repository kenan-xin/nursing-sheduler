"use client";

// Receipts and their Undo (T07).
//
// A RECEIPT IS DERIVED FROM COMMITTED STATE. Its summary is the diff the Apply
// transaction computed between the document it read and the document it wrote -- not
// the Preview the user was shown. If a Preview and a receipt could ever disagree,
// the receipt is the one that happened.
//
// UNDO AUTHORITY COMES FROM THE REPOSITORY, EVERY TIME. The three states below are
// re-derived from persisted commit facts on every refresh, never stored on the
// receipt and never inferred from an in-memory stack:
//
//   available   — this receipt's commit IS the current reversible top of the
//                 current history session, and its reversal payload is still live;
//   superseded  — the document has moved on from the revision this receipt produced;
//   unavailable — a reload, a Load/replace or an eviction removed the reversal path.
//
// "You can no longer undo this" and "this never happened" are different facts, so a
// receipt is KEPT in all three states and only the control changes.

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { SCOPE_LABEL } from "@/lib/proposal";
import type { AssistantProposalController } from "./use-assistant-proposals";

export interface AssistantReceiptsProps {
  controller: AssistantProposalController;
  /** Cap the list so a long conversation does not bury the input. */
  limit?: number;
}

export function AssistantReceipts({ controller, limit = 3 }: AssistantReceiptsProps) {
  const standings = controller.receipts.slice(0, limit);
  if (standings.length === 0) return null;

  return (
    <div className="mx-3 mb-2 flex shrink-0 flex-col gap-2" data-testid="assistant-receipts">
      {standings.map(({ receipt, undo, reason }) => (
        <Surface
          key={receipt.receiptId}
          level="well"
          geometry="control"
          className="flex flex-col gap-2 p-3"
          data-testid="assistant-receipt"
          data-receipt-id={receipt.receiptId}
          data-undo={undo}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta font-semibold text-ink">Change applied</span>
            <Badge
              variant={
                undo === "available" ? "success" : undo === "superseded" ? "warn" : "neutral"
              }
            >
              {undo === "available"
                ? "Undo available"
                : undo === "superseded"
                  ? "Superseded"
                  : "Undo no longer available"}
            </Badge>
          </div>

          <ul className="flex flex-col gap-0.5">
            {receipt.summary.slice(0, 6).map((entry) => (
              <li key={entry.key} className="text-meta text-ink2">
                <span className="font-semibold text-ink">{entry.label}</span>{" "}
                <span className="text-ink3">({SCOPE_LABEL[entry.scope]})</span>{" "}
                {entry.before ?? "Nothing"} → {entry.after ?? "Removed"}
              </li>
            ))}
            {receipt.summary.length > 6 ? (
              <li className="text-meta text-ink3">
                and {receipt.summary.length - 6} more change
                {receipt.summary.length - 6 === 1 ? "" : "s"}
              </li>
            ) : null}
          </ul>

          {receipt.capabilityIds.length > 0 ? (
            <p className="text-meta text-ink3">Affects: {receipt.capabilityIds.join(", ")}</p>
          ) : null}

          {undo === "available" ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                data-testid="receipt-undo"
                onClick={() => void controller.undo(receipt.receiptId)}
              >
                Undo this change
              </Button>
            </div>
          ) : (
            // No disabled Undo button: an affordance that cannot act still reads as a
            // promise. The reason is stated instead.
            <p className="text-meta text-ink3" data-testid="receipt-undo-reason">
              {reason}
            </p>
          )}
        </Surface>
      ))}
    </div>
  );
}
