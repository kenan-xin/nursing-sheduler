"use client";

// The assistant's single mount point (T04).
//
// THE DISCOVERABILITY RULE, implemented structurally rather than by hiding things:
// while AI is off, not configured, or not probe-passed, this component renders
// NOTHING. No launcher, no reserved panel space, and -- most importantly -- no
// mounted CopilotKit provider, so the credential headers do not exist on any
// mounted transport. Settings stays the only way to discover the feature.
//
// THE PROVIDER MOUNTS WITH THE PANEL, not with the app. `runtimeUrl` makes the
// provider handshake with the SAME-ORIGIN runtime (`/info`); no OpenRouter request
// happens until an explicit send, because the runtime only builds a provider client
// inside an `/agent/run`. Deferring the mount to panel-open keeps even that
// same-origin handshake out of an ordinary page load.
//
// `headers` is passed as a FUNCTION deliberately: it is evaluated per request, so a
// key replaced or removed while the panel is open takes effect on the next request
// rather than being captured once at mount.

import { useEffect } from "react";
import { AssistantCopilotProvider } from "./assistant-copilot-provider";
import { AI_KEY_HEADER, AI_MODEL_HEADER, COPILOT_RUNTIME_URL } from "@/lib/ai/protocol";
import { hydrateAssistant, selectReady, useAssistantStore } from "@/lib/ai/assistant/store";
import { AssistantPanel } from "./assistant-panel";
import { useInterruptionWatch } from "./use-interruption-watch";

/**
 * Read the durable settings row once per page lifetime, finish any interrupted clear,
 * settle any turn left mid-flight by the previous lifetime, and watch for the
 * ownership/identity interruption triggers.
 *
 * Mounted in the app shell, ABOVE the panel, so all of it runs whether or not the user
 * ever opens the assistant. The watch in particular has to live here rather than in
 * the panel: a takeover must interrupt a turn even if the panel was closed while it
 * was still streaming.
 */
export function useAssistantHydration(): void {
  useEffect(() => {
    void hydrateAssistant();
  }, []);
  useInterruptionWatch();
}

export function AssistantSurface() {
  const ready = useAssistantStore(selectReady);
  const panelOpen = useAssistantStore((state) => state.panelOpen);

  if (!ready || !panelOpen) return null;

  return (
    <AssistantCopilotProvider
      runtimeUrl={COPILOT_RUNTIME_URL}
      headers={(): Record<string, string> => {
        const settings = useAssistantStore.getState().settings;
        // Absent rather than empty when not ready: the run route rejects a request
        // with no credential at the HTTP boundary, which is the outcome we want if
        // this is ever reached in a non-ready state.
        if (!settings.apiKey || !settings.modelId) return {};
        return {
          [AI_KEY_HEADER]: settings.apiKey,
          [AI_MODEL_HEADER]: settings.modelId,
        };
      }}
      // The Inspector is a development affordance that renders conversation and
      // tool payloads; this app's content is scheduling data, so it stays off.
      showDevConsole={false}
    >
      {/* The v2 stylesheet's reset is scoped to `[data-copilotkit]`, so the library's
          own components only get their intended baseline inside this subtree -- and
          the app's global typography and tokens are untouched everywhere else.

          THAT SHEET IS IMPORTED IN `app/layout.tsx`, and this comment used to be the
          whole of the claim. It was not true: nothing imported
          `@copilotkit/react-core/v2/styles.css`, a production build emitted zero
          `[data-copilotkit]` rules, and every `cpk:*` class in the library's markup
          was an inert string -- so the shipped panel had no scroll bound, no composer
          row and no message bubbles. `components/ai/assistant-styles.test.ts` now
          holds both halves of what this paragraph asserts: that the import exists, and
          that the sheet cannot paint outside this subtree.

          `contents` keeps the wrapper out of layout so the dock and sheet size against
          the app shell. One consequence: the package's scoped
          `background-color: var(--background)` on this element does not paint, and the
          dock's own `Surface` supplies the same `--surface` tone instead. */}
      <div data-copilotkit className="contents">
        <AssistantPanel />
      </div>
    </AssistantCopilotProvider>
  );
}
