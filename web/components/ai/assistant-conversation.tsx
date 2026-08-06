"use client";

// The two conversation renderings (T04).
//
// They are SEPARATE COMPONENTS, not one component with a flag, and that is the
// point: a historical thread must have no live tool or action handlers, and the
// most reliable way to guarantee that is for the historical rendering never to
// construct an agent at all. `AssistantLiveConversation` mounts the turn controller
// and the read-only tools; `AssistantHistoricalConversation` renders messages read
// straight from IndexedDB through the message view, which has no input and no
// handler surface to regain.

import { useEffect, useState } from "react";
import { CopilotChatMessageView, CopilotChatView } from "@copilotkit/react-core/v2";
import type { Message } from "@ag-ui/client";
import { readThreadMessages } from "@/lib/ai/assistant/history-repo";
import { toTransportThread } from "@/lib/ai/assistant/messages";
import { describeRefusal } from "@/lib/ai/assistant/send-gate";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import { useAssistantSession } from "./use-assistant-session";
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

function DetachedNotice() {
  const reason = useAssistantStore((state) => state.detachedReason);
  if (!reason) return null;
  return (
    <p className="px-4 pb-2 text-meta text-ink2" role="status" data-testid="assistant-detached">
      That reply stopped before it finished. Anything already shown is kept; nothing in your
      schedule was changed. Send again to retry.
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

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-live-conversation">
      {session.messages.length === 0 && <WelcomeState />}
      <RefusalNotice />
      <DetachedNotice />
      <CopilotChatView
        className="min-h-0 flex-1"
        messages={session.messages}
        isRunning={session.isRunning}
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
