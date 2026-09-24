"use client";

// The assistant's only entry point (T04).
//
// Renders nothing until AI is enabled AND a probe-passed key and model are stored.
// That is the enablement flow's discoverability rule: while Off, Configuring, or
// not Ready, no launcher and no contextual AI action exists anywhere in the app --
// so a user who has not opted in never sees a control that would fail.

import { Button } from "@/components/ui/button";
import { FaWandMagicSparkles } from "@/components/icons";
import {
  assistantActions,
  hasLiveAssistantWork,
  selectReady,
  useAssistantStore,
  type AssistantUiState,
} from "@/lib/ai/assistant/store";

/**
 * How many cards wait on the user: a Preview to Apply, a run card to press, an option
 * card to answer. A Preview or run card from a stopped turn has no live control, so it
 * waits on nothing -- the same epoch test the cards themselves use.
 */
function selectAttentionCount(state: AssistantUiState): number {
  const live = (card: { turnEpoch: number } | null) =>
    card !== null && card.turnEpoch === state.turnEpoch && state.interruption === null;
  return (
    Number(live(state.activeProposal)) +
    Number(live(state.activeRunRequest)) +
    Number(state.activeChoices !== null)
  );
}

export function formatAttentionCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function AssistantLauncher() {
  const ready = useAssistantStore(selectReady);
  const panelOpen = useAssistantStore((state) => state.panelOpen);
  const attention = useAssistantStore(selectAttentionCount);
  const busy = useAssistantStore(hasLiveAssistantWork);

  if (!ready) return null;

  // Icon-only: the states change the accessible name, never add visible text.
  // Needs-you wins over working; neither shows while the dock is open.
  const needsYou = !panelOpen && attention > 0;
  const working = !panelOpen && !needsYou && busy;
  const label = panelOpen
    ? "Hide assistant"
    : needsYou
      ? `Show assistant, ${attention} ${attention === 1 ? "item needs" : "items need"} you`
      : working
        ? "Show assistant, working"
        : "Show assistant";

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      onClick={assistantActions.togglePanel}
      aria-pressed={panelOpen}
      data-testid="assistant-launcher"
    >
      <FaWandMagicSparkles aria-hidden />
      <span className="sr-only">{label}</span>
      {needsYou ? (
        <span
          aria-hidden
          data-testid="assistant-launcher-badge"
          className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-pill bg-fill-warn px-1 text-label leading-none font-semibold text-on-warn"
        >
          {formatAttentionCount(attention)}
        </span>
      ) : null}
      {working ? (
        // Same pulse as the panel's "Thinking…" dot; the global reduced-motion rule
        // stills it to a static dot.
        <span
          aria-hidden
          data-testid="assistant-launcher-working"
          className="absolute top-0.5 right-0.5 size-2 animate-pulse rounded-[50%] bg-brand"
        />
      ) : null}
    </Button>
  );
}
