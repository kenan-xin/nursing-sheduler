"use client";

// The assistant's only entry point (T04).
//
// Renders nothing until AI is enabled AND a probe-passed key and model are stored.
// That is the enablement flow's discoverability rule: while Off, Configuring, or
// not Ready, no launcher and no contextual AI action exists anywhere in the app --
// so a user who has not opted in never sees a control that would fail.

import { Button } from "@/components/ui/button";
import { FaWandMagicSparkles } from "@/components/icons";
import { assistantActions, selectReady, useAssistantStore } from "@/lib/ai/assistant/store";

export function AssistantLauncher() {
  const ready = useAssistantStore(selectReady);
  const panelOpen = useAssistantStore((state) => state.panelOpen);

  if (!ready) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={assistantActions.togglePanel}
      aria-pressed={panelOpen}
      data-testid="assistant-launcher"
    >
      <FaWandMagicSparkles aria-hidden />
      <span className="sr-only">{panelOpen ? "Hide assistant" : "Show assistant"}</span>
    </Button>
  );
}
