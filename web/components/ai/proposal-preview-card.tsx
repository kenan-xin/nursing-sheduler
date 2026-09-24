"use client";

// The host-rendered Preview, its structured confirmations, and the receipt (T07).
//
// NOT A MESSAGE. This card is rendered by the app beneath the conversation, from
// app state, with app handlers. It is deliberately not part of the transcript: a
// message is a record of something that was said, and a record must not carry a
// live control. That is also what makes "historical messages never regain live
// Apply handlers" structural -- there is no handler in a message to regain.
//
// EVERYTHING SHOWN IS HOST-DERIVED. The before/after values, the cascade, the
// affected screens, the Needs-review markers and the confirmation questions all come
// from `lib/proposal`, computed by comparing documents. The model's contribution is
// one paragraph, labelled as its reasoning and rendered as plain text.
//
// VISUAL ROLE: a card in the dock above the composer (`DockCard`), with the change
// list scrolling inside it so the decision rows stay on screen. What it does NOT
// follow is the prototype's immediate Apply: the closed flows replace that with
// Preview -> confirmation -> explicit Apply, and this file is where the two differ.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import {
  SCOPE_LABEL,
  SETUP_DOMAIN_LABEL,
  activeConfirmations,
  type ProposalDiffEntry,
} from "@/lib/proposal";
import { REST_PRACTICE_WARNING, relaxesRestRule } from "@/lib/ai/assistant/playbook";
import type { AssistantProposalV1 } from "@/lib/store";
import type { ProposalReadiness } from "@/lib/proposal";
import type { AssistantProposalController } from "./use-assistant-proposals";
import { DockCard } from "./dock-card";

function ChangeRow({ entry }: { entry: ProposalDiffEntry }) {
  return (
    <li
      className="flex flex-col gap-0.5 border-b border-line2 px-3 py-2 last:border-b-0"
      data-testid="proposal-change"
      data-change-key={entry.key}
      data-change-kind={entry.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta font-semibold text-ink">{entry.label}</span>
        <Badge variant="neutral" casing="normal">
          {SCOPE_LABEL[entry.scope]}
        </Badge>
      </div>
      {/* Before and after are always BOTH stated, including the absent side, so a
          removal never reads as a blank the user has to interpret. */}
      <p className="text-meta text-ink2">
        <span data-testid="change-before">{entry.before ?? "Nothing"}</span>
        {" → "}
        <span data-testid="change-after">{entry.after ?? "Removed"}</span>
      </p>
    </li>
  );
}

function ChangeList({
  title,
  entries,
  testId,
}: {
  title: string;
  entries: readonly ProposalDiffEntry[];
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">{title}</h4>
      <Surface level="well" geometry="control" className="overflow-hidden">
        <ul>
          {entries.map((entry) => (
            <ChangeRow key={entry.key} entry={entry} />
          ))}
        </ul>
      </Surface>
    </section>
  );
}

function Confirmations({
  proposal,
  controller,
}: {
  proposal: AssistantProposalV1;
  controller: AssistantProposalController;
}) {
  if (proposal.assumptions.length === 0) return null;
  const answered = new Set(
    activeConfirmations(proposal.assumptions, proposal.confirmations, proposal.revision).map(
      (confirmation) => confirmation.assumptionId,
    ),
  );

  return (
    <section className="flex flex-col gap-1.5" data-testid="proposal-confirmations">
      <h4 className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
        Confirm before applying
      </h4>
      {proposal.assumptions.map((assumption) => {
        const confirmed = answered.has(assumption.assumptionId);
        return (
          <Surface
            key={assumption.assumptionId}
            level="well"
            geometry="control"
            emphasis="hairline"
            className="flex flex-col gap-2 p-3"
            data-testid="proposal-assumption"
            data-assumption-id={assumption.assumptionId}
            data-confirmed={confirmed}
          >
            {/* The HOST's question, about one named person, date and action. A
                conversational "yes" in the transcript is not one of these. */}
            <p className="text-meta font-semibold text-ink">{assumption.question}</p>
            <p className="text-meta text-ink2">{assumption.detail}</p>
            <div className="flex items-center gap-2">
              {confirmed ? (
                <>
                  <Badge variant="success">Confirmed</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="assumption-withdraw"
                    onClick={() => void controller.withdraw(assumption.assumptionId)}
                  >
                    Undo confirmation
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="assumption-confirm"
                  onClick={() => void controller.confirm(assumption.assumptionId)}
                >
                  Yes, this is agreed
                </Button>
              )}
            </div>
          </Surface>
        );
      })}
    </section>
  );
}

function Blocks({ readiness }: { readiness: ProposalReadiness }) {
  // The confirmation block has its own section with real controls, so repeating it
  // as a warning line would say the same thing twice in two voices.
  const blocks = readiness.blocks.filter((block) => block.code !== "confirmation_required");
  if (blocks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 px-1" data-testid="proposal-blocks" role="status">
      {blocks.map((block) => (
        <li key={block.code} className="text-meta text-warnink" data-block-code={block.code}>
          {block.message}
        </li>
      ))}
    </ul>
  );
}

export interface ProposalPreviewCardProps {
  controller: AssistantProposalController;
  /** The conversation's send path, for the "Tell me what to change" box. */
  onSend: (text: string) => void;
  /** A turn is still running: Apply and a send wait for it. */
  disabled: boolean;
}

/** The Preview. Renders nothing at all when there is no live proposal. */
export function ProposalPreviewCard({ controller, onSend, disabled }: ProposalPreviewCardProps) {
  const [details, setDetails] = useState(false);
  const { proposal, readiness } = controller;
  if (!proposal || !readiness) return null;

  const stale = readiness.status === "stale";
  const hasDetails =
    Boolean(proposal.rationale) ||
    proposal.evidence.length > 0 ||
    proposal.diff.needsReview.length > 0 ||
    proposal.diff.capabilityIds.length > 0;

  return (
    <DockCard
      data-testid="assistant-proposal"
      data-proposal-id={proposal.proposalId}
      data-proposal-revision={proposal.revision}
      data-status={readiness.status}
      title="Make this change?"
      rowsLabel="Your decision"
      // The decision, as option rows. Apply waits for the agreements and for a running
      // turn; the two exits never wait.
      options={[
        {
          label: controller.applying ? "Applying…" : "Apply",
          detail: "Make this change now.",
          primary: true,
          testId: "proposal-apply",
          disabled: disabled || !readiness.applyEnabled || controller.applying,
          onPick: () => void controller.apply(),
        },
        // REVISE is not a softer Cancel. It marks this change out of date and hands the
        // conversation back, so the next thing the assistant prepares keeps this
        // proposal's identity and moves its revision -- which is exactly what
        // invalidates the confirmations already given. Cancel is terminal.
        {
          label: "Change something",
          detail: "Set it aside and tell me what to adjust.",
          testId: "proposal-revise",
          onPick: () => void controller.revise(),
        },
        {
          label: "Cancel",
          detail: "Drop this change. Nothing is applied.",
          testId: "proposal-cancel",
          onPick: () => void controller.cancel(),
        },
      ]}
      // Revise, then say what to change: the same ending as Change something, with
      // the user's words sent as an ordinary message.
      other={{
        label: "Tell me what to change",
        sendLabel: "Send what to change",
        disabled,
        onSend: (text) => void controller.revise().then(() => onSend(text)),
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-1">
        {stale ? (
          <Badge variant="warn" data-testid="proposal-stale">
            Out of date
          </Badge>
        ) : null}
        {/* Never “checked” unless something actually checked it. T10 supplies the
            tested case; until then the honest label is Untested. */}
        <Badge
          variant={proposal.outcome === "optimizer_tested" ? "success" : "neutral"}
          data-testid="proposal-outcome"
        >
          {proposal.outcome === "optimizer_tested"
            ? "Optimiser-tested"
            : proposal.outcome === "inconclusive"
              ? "Inconclusive"
              : "Not tested by the optimiser"}
        </Badge>
      </div>

      {/* The summary scrolls inside the card, so the rows and the composer stay on
          screen however long the cascade is. */}
      <div className="flex max-h-60 min-h-0 flex-col gap-3 overflow-y-auto px-1">
        <ChangeList title="What changes" entries={proposal.diff.direct} testId="proposal-direct" />
        {/* Shown WITH the direct changes, never behind the details toggle: the flow
            requires the full downstream consequence to be visible before Apply. */}
        <ChangeList
          title="Knock-on effects"
          entries={proposal.diff.cascade}
          testId="proposal-cascade"
        />

        {relaxesRestRule(proposal.commands) ? (
          <p className="text-meta text-warnink" data-testid="proposal-rest-guidance" role="note">
            {REST_PRACTICE_WARNING}
          </p>
        ) : null}

        <Confirmations proposal={proposal} controller={controller} />

        {hasDetails ? (
          <Button
            variant="link"
            size="sm"
            className="self-start px-0"
            aria-expanded={details}
            data-testid="proposal-details-toggle"
            onClick={() => setDetails((open) => !open)}
          >
            {details ? "Hide details" : "Show details"}
          </Button>
        ) : null}
        {details ? (
          <div className="flex flex-col gap-2" data-testid="proposal-details">
            {proposal.rationale ? (
              <p className="text-meta text-ink2" data-testid="proposal-rationale">
                <span className="font-semibold text-ink3">Assistant&apos;s reasoning: </span>
                {proposal.rationale}
              </p>
            ) : null}
            {proposal.evidence.length > 0 ? (
              <div className="flex flex-wrap gap-1.5" data-testid="proposal-evidence">
                {proposal.evidence.map((entry) => (
                  <Badge key={`${entry.kind}:${entry.label}`} variant="outline" casing="normal">
                    {entry.label}
                  </Badge>
                ))}
              </div>
            ) : null}
            {proposal.diff.needsReview.length > 0 ? (
              <p className="text-meta text-warnink" data-testid="proposal-needs-review">
                After applying, these will need another look:{" "}
                {proposal.diff.needsReview.map((domain) => SETUP_DOMAIN_LABEL[domain]).join(", ")}.
              </p>
            ) : null}
            {proposal.diff.capabilityIds.length > 0 ? (
              <p className="text-meta text-ink3" data-testid="proposal-screens">
                Affects: {proposal.diff.capabilityIds.join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Blocks readiness={readiness} />
      {controller.outcome?.kind === "failed" ? (
        <p
          className="px-1 text-meta text-errorink"
          role="status"
          data-testid="proposal-apply-failed"
        >
          {controller.outcome.message}
        </p>
      ) : null}
    </DockCard>
  );
}
