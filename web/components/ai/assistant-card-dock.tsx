"use client";

// The card dock: the assistant's questions and decisions, docked directly above the
// composer, the way a coding agent asks a question in its prompt box.
//
// PLACEMENT. `CopilotChatView` renders its composer through the `input` slot, inside
// its own bottom overlay, and pads the transcript by that overlay's measured height.
// So the dock is mounted by replacing the slot with `DockedComposer`: the dock, then
// the library's own `CopilotChatInput` with every prop the view passed. The transcript
// keeps scrolling above and is never covered, because the view already measures the
// whole overlay. No portal, no DOM surgery, no second composer.
//
// LIVE ONLY. The slot is passed by `AssistantLiveConversation` alone, and the handlers
// reach the dock through `CardDockContext`, which only the live rendering provides. A
// historical thread renders the message view with no input at all, so it has no dock
// and no handler to regain.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { CopilotChatInput } from "@copilotkit/react-core/v2";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import type { AssistantProposalController } from "./use-assistant-proposals";
import { ChoiceCard } from "./choice-card";
import { DockServicesContext } from "./dock-card";
import { DiagnosticSearchCard } from "./diagnostic-search-card";
import { OptimizeRunRequestCard } from "./optimize-run-request-card";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { RosterChangeCard } from "./roster-change-card";

export interface CardDockValue {
  /** The conversation's one send path. */
  onSend: (text: string) => void;
  /** A turn is still running: picks that send or apply wait for it. */
  disabled: boolean;
  proposals: AssistantProposalController;
}

export const CardDockContext = createContext<CardDockValue | null>(null);

/** Which cards are up, each by an identity that changes when a new card replaces it. */
function useDockKeys(proposals: AssistantProposalController | undefined) {
  const diagnostic = useAssistantStore((s) => s.activeDiagnostic?.search.searchId ?? null);
  const run = useAssistantStore((s) => (s.activeRunRequest ? s.activeRunRequest.turnEpoch : null));
  const roster = useAssistantStore((s) =>
    s.activeRosterChange
      ? `roster:${s.activeRosterChange.id}`
      : s.rosterChangeNotice !== null
        ? "roster-notice"
        : null,
  );
  const choice = useAssistantStore((s) => s.activeChoices?.id ?? null);
  const proposal =
    proposals?.proposal && proposals.readiness ? proposals.proposal.proposalId : null;
  return {
    diagnostic: diagnostic === null ? null : `diagnostic:${diagnostic}`,
    run: run === null ? null : `run:${run}`,
    roster,
    choice: choice === null ? null : `choice:${choice}`,
    proposal: proposal === null ? null : `proposal:${proposal}`,
  };
}

/** A card is waiting for the user's pick (the diagnostic card only reports). */
function useCardOpen(proposals: AssistantProposalController | undefined): boolean {
  const keys = useDockKeys(proposals);
  return Boolean(keys.run || keys.roster?.startsWith("roster:") || keys.choice || keys.proposal);
}

/** The stacked cards, newest nearest the composer. */
function AssistantCardDock({ value }: { value: CardDockValue }) {
  const keys = useDockKeys(value.proposals);
  // First-seen order. A replacing card has a new key, so it counts as new.
  const seen = useRef(new Map<string, number>());
  const cards: [string | null, ReactNode][] = [
    [keys.diagnostic, <DiagnosticSearchCard />],
    [keys.run, <OptimizeRunRequestCard />],
    [keys.roster, <RosterChangeCard onSend={value.onSend} disabled={value.disabled} />],
    [keys.choice, <ChoiceCard onSend={value.onSend} disabled={value.disabled} />],
    [
      keys.proposal,
      <ProposalPreviewCard
        controller={value.proposals}
        onSend={value.onSend}
        disabled={value.disabled}
      />,
    ],
  ];
  const up = cards.filter((card): card is [string, ReactNode] => card[0] !== null);
  if (up.length === 0) return null;
  for (const [key] of up) if (!seen.current.has(key)) seen.current.set(key, seen.current.size);
  up.sort(([a], [b]) => (seen.current.get(a) ?? 0) - (seen.current.get(b) ?? 0));

  return (
    <div
      data-testid="assistant-card-dock"
      // Capped, with its own scroll, so a stack of cards never pushes the composer off.
      className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pb-2"
    >
      {up.map(([key, card]) => (
        <div key={key} className="flex flex-col">
          {card}
        </div>
      ))}
    </div>
  );
}

/** Under the composer while a card is open, in place of the library's disclaimer. */
function DockHint() {
  return (
    <p className="px-4 py-2 text-center text-label text-ink3" data-testid="assistant-dock-hint">
      ↑ ↓ to move, Enter to pick, or type below
    </p>
  );
}

/** The `input` slot: the card dock, then the library's composer, unchanged. */
function DockedComposerView(props: ComponentProps<typeof CopilotChatInput>) {
  const value = useContext(CardDockContext);
  const open = useCardOpen(value?.proposals);
  const container = useRef<HTMLDivElement>(null);
  const focusComposer = useCallback(
    () => container.current?.querySelector("textarea")?.focus(),
    [],
  );
  const [announcement, setAnnouncement] = useState("");
  const services = useMemo(() => ({ focusComposer, announce: setAnnouncement }), [focusComposer]);

  return (
    <>
      {value ? (
        <div
          className="pointer-events-auto mx-auto w-full max-w-3xl px-4"
          // The app-owned subtree inside the library's chat root (see globals.css §4).
          data-assistant-dock=""
        >
          {/* Always mounted, so a new card's title is announced rather than lost. */}
          <p className="sr-only" aria-live="polite" data-testid="assistant-dock-announcer">
            {announcement}
          </p>
          <DockServicesContext.Provider value={services}>
            <AssistantCardDock value={value} />
          </DockServicesContext.Provider>
        </div>
      ) : null}
      <CopilotChatInput
        {...props}
        containerRef={container}
        textArea={open ? { placeholder: "Or reply directly…" } : undefined}
        disclaimer={open ? DockHint : props.disclaimer}
      />
    </>
  );
}

/**
 * The slot's type is the input component itself, sub-components included, so the
 * replacement carries them too: anything that reaches for `input.SendButton` still
 * finds the library's.
 */
export const DockedComposer = Object.assign(DockedComposerView, CopilotChatInput);
