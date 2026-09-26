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
// thread has no Apply handler to regain -- not a disabled one, none at all. They sit
// in the card dock above the composer (`assistant-card-dock.tsx`), which reaches the
// live handlers only through the context this rendering provides.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { CopilotChatMessageView, CopilotChatView } from "@copilotkit/react-core/v2";
import type { Message } from "@ag-ui/client";
import { readThreadMessages } from "@/lib/ai/assistant/history-repo";
import { toTransportThread } from "@/lib/ai/assistant/messages";
import { describeInterruptionPhase, describeSettlement } from "@/lib/ai/assistant/lifecycle";
import { describeRefusal } from "@/lib/ai/assistant/send-gate";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useAssistantSession, type AssistantActivity } from "./use-assistant-session";
import { useAssistantProposals } from "./use-assistant-proposals";
import { useAssistantFollowUps } from "./use-assistant-follow-ups";
import { CardDockContext, DockedComposer } from "./assistant-card-dock";
import { AssistantReceipts } from "./assistant-receipts";
import { ApplyNavigationNotice } from "./apply-navigation-notice";
import { useAssistantRetry } from "./use-assistant-retry";
import { Button } from "@/components/ui/button";
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
        I can read your roster period, staff, shifts, rules and requests. I can suggest changes, but
        nothing changes until you say so, and I only start the optimiser when you press Run.
      </p>
    </Surface>
  );
}

export function RefusalNotice() {
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
 *
 * `onRetry` is the HOST's, and only for the settlement that has one: it is the
 * failed-turn Retry, and a notice rendered without it -- the historical panel, the
 * interruption line -- simply states the fact and offers nothing. The wording already
 * says "Send again to retry." for exactly the settlements this appears beside.
 */
export function LifecycleNotice({ onRetry = null }: { onRetry?: (() => void) | null }) {
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
    <div className="flex flex-wrap items-center gap-2 px-4 pb-2" role="status" aria-live="polite">
      <p
        className="text-meta text-ink2"
        data-testid="assistant-settlement"
        data-settlement={settlement.settlement}
      >
        {describeSettlement(settlement.settlement, settlement.trigger)}
      </p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} data-testid="assistant-retry">
          Retry
        </Button>
      )}
    </div>
  );
}

/** What each model-visible tool is doing, in the user's terms. */
export const TOOL_ACTIVITY: Readonly<Record<string, string>> = {
  get_schedule_overview: "Reading your schedule…",
  get_schedule_section: "Reading your schedule…",
  test_feasibility_candidates: "Testing possible fixes…",
  list_app_capabilities: "Checking what the app can do…",
  explain_app_capability: "Checking what the app can do…",
  suggest_scheduling_rule: "Drafting a rule…",
  open_app_screen: "Opening a screen…",
  prepare_scenario_change: "Preparing a change…",
  request_optimize_run: "Offering an optimiser run…",
  get_optimize_result: "Checking the optimiser run…",
  offer_choices: "Offering choices…",
  get_setup_progress: "Checking your set-up…",
  suggest_feasibility_options: "Looking for ways to fill the gaps…",
  get_roster: "Reading the roster…",
  find_swap_partners: "Looking for who can swap…",
  prepare_roster_swap: "Preparing a swap…",
  prepare_borrowed_cover: "Preparing a temporary nurse…",
};

/**
 * The pending line under the transcript: "Thinking…" until the first token or tool
 * event, then the running tool's label. Same dot-plus-words pattern as the roster's
 * "Saving…"; the global reduced-motion rule stills the pulse.
 */
export function AssistantActivityStatus({ activity }: { activity: AssistantActivity }) {
  if (!activity) return null;
  const label =
    activity.kind === "tool" ? (TOOL_ACTIVITY[activity.name] ?? "Working…") : "Thinking…";
  return (
    <p
      className="flex items-center gap-2 text-meta text-ink2"
      role="status"
      aria-live="polite"
      data-testid="assistant-activity"
      data-kind={activity.kind}
    >
      <span className="size-1.5 animate-pulse rounded-[50%] bg-brand" aria-hidden />
      {label}
    </p>
  );
}

// The locked view renders its `cursor` slot with no props, so the activity reaches it
// through context rather than a per-render component (which would remount the live
// region and re-announce it).
const ActivityContext = createContext<AssistantActivity>(null);
function ActivityCursor() {
  return <AssistantActivityStatus activity={useContext(ActivityContext)} />;
}
const MESSAGE_VIEW = { cursor: ActivityCursor };

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
  // HOST STATE, HOST HANDLERS. The Preview and the receipts are host surfaces, not
  // entries in the transcript -- see the note in `proposal-preview-card.tsx`.
  const proposals = useAssistantProposals();
  const running = session.isRunning || session.interrupting;
  // The panel keys this component by thread, and the thread follows the scenario, so a
  // switch unmounts it: an open question must not carry over to another thread.
  useEffect(() => () => assistantActions.clearChoices(), []);
  // The ONE send path, for the composer and the option card alike. Any send answers
  // (or overrides) an open option card, so it closes here. The follow-up after an
  // Apply or an offered run uses it too; a user send first drops a waiting one.
  const sendMessage = useAssistantFollowUps(
    running || session.sending,
    proposals.outcome,
    (text: string) => {
      assistantActions.clearChoices();
      return session.send(text);
    },
  );
  const dock = useMemo(
    () => ({ onSend: sendMessage, disabled: running, proposals }),
    [sendMessage, running, proposals],
  );
  // The failed turn's Retry, through the SESSION'S OWN send -- the same function the
  // composer's path calls, given the failed turn's id so the gate replaces it. Deliberately
  // not wrapped in another adapter: an adapter here is one more place a send option could
  // be dropped, and the retry's whole contract is that it carries that id to the gate.
  // It closes an open option card itself, for the same reason the composer does.
  const retry = useAssistantRetry({
    threadId,
    send: session.send,
    busy: running || session.sending,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-live-conversation">
      {session.messages.length === 0 && <WelcomeState />}
      <RefusalNotice />
      <LifecycleNotice onRetry={retry.canRetry ? retry.retry : null} />
      <AssistantReceipts controller={proposals} />
      <ApplyNavigationNotice controller={proposals} />
      <ActivityContext.Provider value={session.activity}>
        <CardDockContext.Provider value={dock}>
          <CopilotChatView
            className="min-h-0 flex-1"
            messages={session.messages}
            // Replaces the library's unlabeled dot with a worded, announced status line.
            messageView={MESSAGE_VIEW}
            // The questions and decisions dock directly above the composer.
            input={DockedComposer}
            // Still "running" while an interruption settles: the input must stay closed
            // until the gate reopens, and Stop must stay reachable rather than flipping
            // back to a send control that would be refused.
            isRunning={running}
            // Suppresses the library's generic greeting: this panel is bound to one
            // explicit scenario thread, and the welcome content above is the app's.
            hasExplicitThreadId
            onSubmitMessage={sendMessage}
            onStop={session.stop}
          />
        </CardDockContext.Provider>
      </ActivityContext.Provider>
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
      {/* Message view only: no input, no tools, no run controls. Same horizontal
          inset as the host cards above (`--space-4` via `px-4`) and the live
          transcript's cap below, so a resized-wide dock reads at the same measure
          whichever rendering is on screen. */}
      <CopilotChatMessageView
        className="mx-auto min-h-0 w-full max-w-[70ch] flex-1 overflow-y-auto px-4"
        messages={messages}
      />
    </div>
  );
}
