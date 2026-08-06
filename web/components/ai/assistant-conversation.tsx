"use client";

// The two conversation renderings (T04).
//
// They are SEPARATE COMPONENTS, not one component with a flag, and that is the
// point: a historical thread must have no live tool or action handlers, and the
// most reliable way to guarantee that is for the historical rendering never to
// construct an agent at all. `AssistantLiveConversation` mounts the turn controller,
// the tools, and the host Preview/receipt surface; `AssistantHistoricalConversation`
// renders messages read straight from IndexedDB through the message view, which has
// no input and no handler surface to regain.
//
// T07 keeps that property rather than weakening it. The Preview card and the Apply
// control are mounted HERE, in the live rendering only, so a read-only or historical
// thread has no Apply handler to regain -- not a disabled one, none at all.

import { useEffect, useState } from "react";
import { CopilotChatMessageView, CopilotChatView } from "@copilotkit/react-core/v2";
import type { Message } from "@ag-ui/client";
import { readThreadMessages } from "@/lib/ai/assistant/history-repo";
import { toTransportThread } from "@/lib/ai/assistant/messages";
import { describeInterruptionPhase, describeSettlement } from "@/lib/ai/assistant/lifecycle";
import { describeRefusal } from "@/lib/ai/assistant/send-gate";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import { useAssistantSession } from "./use-assistant-session";
import { useAssistantProposals } from "./use-assistant-proposals";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { AssistantReceipts } from "./assistant-receipts";
import { Surface } from "@/components/ui/surface";

/** The app's own welcome content. Local text; no provider request produces it. */
function WelcomeState() {
  return (
    <Surface
      level="well"
      geometry="control"
      className="m-4 flex flex-col gap-2 p-4"
      data-testid="assistant-welcome"
    >
      <p className="text-body text-ink">
        Ask about this schedule and I&apos;ll explain what I can see.
      </p>
      <p className="text-meta text-ink2">
        I can read your roster period, staff, shifts, rules and requests. I cannot change anything
        yet, and I never run the optimiser.
      </p>
    </Surface>
  );
}

function RefusalNotice() {
  const refusal = useAssistantStore((state) => state.lastRefusal);
  if (!refusal) return null;
  return (
    <p className="px-4 pb-2 text-meta text-errorink" role="status" data-testid="assistant-refusal">
      {describeRefusal(refusal)}
    </p>
  );
}

/**
 * The one truthful lifecycle line: Stopping, Settling, Stopped, Cancelled, Detached.
 *
 * ONE component for all of them rather than a notice per state, because they are
 * mutually exclusive faces of the same fact and the reader must never see two at once
 * ("Stopping…" above "Stopped." reads as a contradiction). The wording itself lives in
 * `lifecycle.ts` beside the classes it describes, so a new settlement class cannot
 * ship without wording.
 */
function LifecycleNotice() {
  const interruption = useAssistantStore((state) => state.interruption);
  const settlement = useAssistantStore((state) => state.lastSettlement);

  if (interruption) {
    return (
      <p
        className="px-4 pb-2 text-meta text-ink2"
        role="status"
        aria-live="polite"
        data-testid="assistant-interrupting"
        data-phase={interruption.phase}
        data-trigger={interruption.trigger}
      >
        {describeInterruptionPhase(interruption.phase)}
      </p>
    );
  }

  if (!settlement) return null;
  return (
    <p
      className="px-4 pb-2 text-meta text-ink2"
      role="status"
      aria-live="polite"
      data-testid="assistant-settlement"
      data-settlement={settlement.settlement}
    >
      {describeSettlement(settlement.settlement, settlement.trigger)}
    </p>
  );
}

export interface AssistantLiveConversationProps {
  threadId: string;
  routePath: string;
  routeLabel: string | null;
}

export function AssistantLiveConversation({
  threadId,
  routePath,
  routeLabel,
}: AssistantLiveConversationProps) {
  const session = useAssistantSession({ threadId, routePath, routeLabel, historical: false });
  // HOST STATE, HOST HANDLERS. The Preview and the receipts are siblings of the
  // transcript, not entries in it -- see the note in `proposal-preview-card.tsx`.
  const proposals = useAssistantProposals();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-live-conversation">
      {session.messages.length === 0 && <WelcomeState />}
      <RefusalNotice />
      <LifecycleNotice />
      <ProposalPreviewCard controller={proposals} />
      <AssistantReceipts controller={proposals} />
      <CopilotChatView
        className="min-h-0 flex-1"
        messages={session.messages}
        // Still "running" while an interruption settles: the input must stay closed
        // until the gate reopens, and Stop must stay reachable rather than flipping
        // back to a send control that would be refused.
        isRunning={session.isRunning || session.interrupting}
        // Suppresses the library's generic greeting: this panel is bound to one
        // explicit scenario thread, and the welcome content above is the app's.
        hasExplicitThreadId
        onSubmitMessage={(value) => void session.send(value)}
        onStop={session.stop}
      />
    </div>
  );
}

export interface AssistantHistoricalConversationProps {
  threadId: string;
  /** Why this thread is read-only, in the user's terms. */
  reason: string;
}

export function AssistantHistoricalConversation({
  threadId,
  reason,
}: AssistantHistoricalConversationProps) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    let cancelled = false;
    void readThreadMessages(threadId).then((records) => {
      if (!cancelled) setMessages(toTransportThread(records));
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-historical-conversation">
      <Surface level="well" geometry="control" className="m-4 p-3">
        <p className="text-meta text-ink2">{reason}</p>
      </Surface>
      {/* Message view only: no input, no tools, no run controls. */}
      <CopilotChatMessageView className="min-h-0 flex-1 overflow-y-auto" messages={messages} />
    </div>
  );
}
