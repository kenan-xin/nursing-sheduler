"use client";

// Receipts and their Undo (T07), collapsed into one slim bar (bead 3c1).
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
//
// THE BAR, NOT THE STACK (bead 3c1). A receipt per turn used to render as its own
// card, stacked above the chat -- unbounded, pushing the conversation out of view.
// One bar stands in its place, collapsed by default: a count, and -- while the
// newest change is still reversible -- its title and Undo inline, so Undo stays one
// click away without opening anything. Expanded, the list is newest first inside
// its own scrolling region, each older receipt one line until it is opened on its
// own into the same detail body the old stack rendered.

import { useId, useState } from "react";
import { FaChevronDown, FaChevronUp } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { SCOPE_LABEL } from "@/lib/proposal";
import type { AssistantReceiptV1, ReceiptStanding } from "@/lib/store";
import type { AssistantProposalController } from "./use-assistant-proposals";

export interface AssistantReceiptsProps {
  controller: AssistantProposalController;
}

/** A short, human title for a receipt: its first change, plus a count of the rest. */
function receiptTitle(receipt: AssistantReceiptV1): string {
  const [first, ...rest] = receipt.summary;
  if (!first) return "Change applied";
  return rest.length > 0 ? `${first.label} and ${rest.length} more` : first.label;
}

function badgeVariant(undo: ReceiptStanding["undo"]) {
  return undo === "available" ? "success" : undo === "superseded" ? "warn" : "neutral";
}

function badgeLabel(undo: ReceiptStanding["undo"]) {
  return undo === "available"
    ? "Undo available"
    : undo === "superseded"
      ? "Superseded"
      : "Undo no longer available";
}

/** The full receipt body -- unchanged from the old stack, now shown per-row on demand. */
function ReceiptDetail({
  standing,
  controller,
}: {
  standing: ReceiptStanding;
  controller: AssistantProposalController;
}) {
  const { receipt, undo, reason } = standing;
  return (
    <Surface
      level="well"
      geometry="control"
      className="flex flex-col gap-2 p-3"
      data-testid="assistant-receipt"
      data-receipt-id={receipt.receiptId}
      data-undo={undo}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta font-semibold text-ink">Change applied</span>
        <Badge variant={badgeVariant(undo)}>{badgeLabel(undo)}</Badge>
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
  );
}

/** One line in the expanded list: title + badge, opening on its own into the detail. */
function ReceiptRow({
  standing,
  controller,
}: {
  standing: ReceiptStanding;
  controller: AssistantProposalController;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { receipt, undo } = standing;

  return (
    <div
      className="border-b border-line2 last:border-b-0"
      data-testid="assistant-receipt-row"
      data-receipt-id={receipt.receiptId}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-panel-alt focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        data-testid="receipt-row-toggle"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="truncate text-meta text-ink">{receiptTitle(receipt)}</span>
        <Badge variant={badgeVariant(undo)}>{badgeLabel(undo)}</Badge>
      </button>
      {open ? (
        <div id={detailId} className="px-3 pb-3">
          <ReceiptDetail standing={standing} controller={controller} />
        </div>
      ) : null}
    </div>
  );
}

export function AssistantReceipts({ controller }: AssistantReceiptsProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const receipts = controller.receipts;

  if (receipts.length === 0) return null;

  const newest = receipts[0];
  const showNewestInline = !expanded && newest.undo === "available";

  return (
    // One card: the bar is its header, the expanded list its body, so the rows never
    // float loose on the dock plane.
    <Surface
      level="surface"
      geometry="card"
      className="mx-3 mb-2 flex shrink-0 flex-col overflow-hidden"
      data-testid="assistant-receipts"
    >
      <div className="flex items-center gap-2 p-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-between"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          data-testid="assistant-receipts-toggle"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span>
            {receipts.length} change{receipts.length === 1 ? "" : "s"} applied
          </span>
          {expanded ? <FaChevronUp /> : <FaChevronDown />}
        </Button>

        {showNewestInline ? (
          <>
            <span className="truncate text-meta text-ink2">{receiptTitle(newest.receipt)}</span>
            <Button
              variant="outline"
              size="sm"
              data-testid="receipt-undo"
              onClick={() => void controller.undo(newest.receipt.receiptId)}
            >
              Undo
            </Button>
          </>
        ) : null}
      </div>

      {expanded ? (
        <div
          id={listId}
          className="flex max-h-[33vh] flex-col overflow-y-auto border-t border-line2"
          data-testid="assistant-receipts-list"
        >
          {receipts.map((standing) => (
            <ReceiptRow
              key={standing.receipt.receiptId}
              standing={standing}
              controller={controller}
            />
          ))}
        </div>
      ) : null}
    </Surface>
  );
}
