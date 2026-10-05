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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  CopilotChatMessageView,
  CopilotChatUserMessage,
  CopilotChatView,
} from "@copilotkit/react-core/v2";
import type { Message } from "@ag-ui/client";
import { readThreadMessages } from "@/lib/ai/assistant/history-repo";
import { toTransportThread } from "@/lib/ai/assistant/messages";
import { ATTACHMENT_PRIVACY_NOTE } from "@/lib/ai/assistant/attachment-rules";
import { COMPACTION_NOTICE } from "@/lib/ai/assistant/compaction";
import { describeInterruptionPhase, describeSettlement } from "@/lib/ai/assistant/lifecycle";
import { describeRefusal } from "@/lib/ai/assistant/send-gate";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import {
  useAssistantSession,
  type AssistantActivity,
  type AssistantSendOptions,
} from "./use-assistant-session";
import { useAssistantProposals } from "./use-assistant-proposals";
import { isAppFollowUp, useAssistantFollowUps } from "./use-assistant-follow-ups";
import { CardDockContext, DockedComposer } from "./assistant-card-dock";
import { AssistantReceipts } from "./assistant-receipts";
import { ApplyNavigationNotice } from "./apply-navigation-notice";
import { useAssistantRetry } from "./use-assistant-retry";
import { useOpenRosterAfterRun } from "./use-open-roster-after-run";
import { useComposerAttachments } from "./use-composer-attachments";
import { useModelImageInput } from "./use-model-image-input";
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

/** bead ypo: one quiet line while this thread carries a summary of older messages. */
export function CompactionNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="px-4 pb-2 text-meta text-ink2" role="status" data-testid="assistant-compacted">
      {COMPACTION_NOTICE}
    </p>
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
  prepare_borrowed_cover: "Preparing a temporary cover…",
};

/**
 * The pending line under the transcript: "Thinking…" until the first token or tool
 * event, then the running tool's label. Same dot-plus-words pattern as the roster's
 * "Saving…"; the global reduced-motion rule stills the pulse.
 */
export function AssistantActivityStatus({ activity }: { activity: AssistantActivity }) {
  if (!activity) return null;
  const label =
    activity.kind === "tool"
      ? (TOOL_ACTIVITY[activity.name] ?? "Working…")
      : activity.kind === "summarising"
        ? "Summarising earlier messages…"
        : "Thinking…";
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
/** A follow-up the app sent in the user's place says so: the user did not type it (C-36). */
function AppAwareMessageRenderer(props: { content: string; className?: string }) {
  if (!isAppFollowUp(props.content)) return <CopilotChatUserMessage.MessageRenderer {...props} />;
  return (
    <div data-testid="assistant-app-follow-up">
      <CopilotChatUserMessage.MessageRenderer {...props} />
      <p className="px-1 text-right text-label text-ink3">Sent by the app</p>
    </div>
  );
}
const USER_MESSAGE = { messageRenderer: AppAwareMessageRenderer };
const MESSAGE_VIEW = { cursor: ActivityCursor, userMessage: USER_MESSAGE };

const OPEN_PREVIEW_KEY = "assistant.open-preview-thread";

function readOpenPreviewThread(): string | null {
  try {
    return sessionStorage.getItem(OPEN_PREVIEW_KEY);
  } catch {
    return null; // Storage denied: the notice below is best-effort.
  }
}

function writeOpenPreviewThread(threadId: string | null): void {
  try {
    if (threadId) sessionStorage.setItem(OPEN_PREVIEW_KEY, threadId);
    else sessionStorage.removeItem(OPEN_PREVIEW_KEY);
  } catch {
    // Storage denied: the notice below is best-effort.
  }
}

/**
 * A live Preview is memory only, by design (`activeProposal` in the assistant store), so
 * a reload drops the card while the chat still says "press Apply". Only WHICH thread had
 * one open is noted for this tab -- never the proposal, which must not regain a live
 * Apply -- so the page after a reload can say where the card went (C-37). Hidden again
 * once a Preview shows or a turn runs.
 */
export function usePreviewClosedOnReload(threadId: string, running: boolean): boolean {
  const open = useAssistantStore((state) => state.activeProposal !== null);
  const [closed, setClosed] = useState(() => !open && readOpenPreviewThread() === threadId);
  useEffect(() => writeOpenPreviewThread(open ? threadId : null), [open, threadId]);
  if (closed && (open || running)) setClosed(false);
  return closed;
}

export interface AssistantLiveConversationProps {
  threadId: string;
  routePath: string;
  routeLabel: string | null;
  /**
   * Reports whether this conversation currently holds any messages.
   *
   * The panel's header owns the transcript download control and gates it on this,
   * because "is the conversation empty?" is a fact only the rendering knows -- the
   * live one from its agent, the historical one from what it read.
   */
  onHasMessages?: (hasMessages: boolean) => void;
}

export function AssistantLiveConversation({
  threadId,
  routePath,
  routeLabel,
  onHasMessages,
}: AssistantLiveConversationProps) {
  const imageInput = useModelImageInput();
  const session = useAssistantSession({
    threadId,
    routePath,
    routeLabel,
    historical: false,
    imageInput,
  });
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
    (text: string, options?: AssistantSendOptions) => {
      assistantActions.clearChoices();
      return options ? session.send(text, options) : session.send(text);
    },
    proposals.undone,
  );
  const previewClosed = usePreviewClosedOnReload(threadId, running || session.sending);
  const dock = useMemo(
    () => ({ onSend: sendMessage, disabled: running, proposals }),
    [sendMessage, running, proposals],
  );
  // 2by.10. Only a composer submit carries files; cards and follow-ups send text alone.
  // A send refused as busy keeps the queue, an accepted one clears it.
  const attach = useComposerAttachments(imageInput);
  const { ready, consume } = attach;
  const submit = useCallback(
    (text: string) => {
      const files = ready();
      if (files.length === 0) return void sendMessage(text);
      void sendMessage(text, { attachments: files }).then((accepted) => {
        if (accepted) consume();
      });
    },
    [ready, consume, sendMessage],
  );
  // Live only, like the run card that starts the run it follows.
  useOpenRosterAfterRun();
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
  const hasMessages = session.messages.length > 0;
  useEffect(() => {
    onHasMessages?.(hasMessages);
  }, [hasMessages, onHasMessages]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="assistant-live-conversation"
      ref={attach.containerRef}
    >
      {session.messages.length === 0 && <WelcomeState />}
      <RefusalNotice />
      <LifecycleNotice onRetry={retry.canRetry ? retry.retry : null} />
      {previewClosed && (
        <p
          className="px-4 pb-2 text-meta text-ink2"
          role="status"
          data-testid="assistant-preview-closed"
        >
          The Preview closed on reload. Ask again.
        </p>
      )}
      <CompactionNotice show={session.summarised} />
      <AssistantReceipts controller={proposals} />
      <ApplyNavigationNotice controller={proposals} />
      <input
        type="file"
        multiple
        hidden
        ref={attach.fileInputRef}
        accept={attach.accept}
        onChange={attach.handleFileUpload}
        data-testid="assistant-file-input"
      />
      {attach.error && (
        <p
          className="truncate px-4 pb-2 text-meta text-errorink"
          role="status"
          title={attach.error}
          data-testid="assistant-attach-error"
        >
          {attach.error}
        </p>
      )}
      {attach.attachments.length > 0 && (
        <p className="px-4 pb-2 text-meta text-ink2" data-testid="assistant-attach-privacy">
          {ATTACHMENT_PRIVACY_NOTE}
        </p>
      )}
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
            onSubmitMessage={submit}
            onStop={session.stop}
            attachments={attach.attachments}
            onRemoveAttachment={attach.removeAttachment}
            onAddFile={() => attach.fileInputRef.current?.click()}
            dragOver={attach.dragOver}
            onDragOver={attach.handleDragOver}
            onDragLeave={attach.handleDragLeave}
            onDrop={attach.handleDrop}
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
  /** Reports whether the restored history holds any messages. See the live props. */
  onHasMessages?: (hasMessages: boolean) => void;
}

export function AssistantHistoricalConversation({
  threadId,
  reason,
  onHasMessages,
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

  const hasMessages = messages.length > 0;
  useEffect(() => {
    onHasMessages?.(hasMessages);
  }, [hasMessages, onHasMessages]);

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
        userMessage={USER_MESSAGE}
      />
    </div>
  );
}
