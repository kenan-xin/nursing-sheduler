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
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { AI_KEY_HEADER, AI_MODEL_HEADER, COPILOT_RUNTIME_URL } from "@/lib/ai/protocol";
import { hydrateAssistant, selectReady, useAssistantStore } from "@/lib/ai/assistant/store";
import { AssistantPanel } from "./assistant-panel";

/**
 * Read the durable settings row once per page lifetime and settle any turn left
 * mid-flight by the previous one. Mounted in the app shell, above the panel, so it
 * runs whether or not the user ever opens the assistant.
 */
export function useAssistantHydration(): void {
  useEffect(() => {
    void hydrateAssistant();
  }, []);
}

export function AssistantSurface() {
  const ready = useAssistantStore(selectReady);
  const panelOpen = useAssistantStore((state) => state.panelOpen);

  if (!ready || !panelOpen) return null;

  return (
    <CopilotKitProvider
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
          the app's global typography and tokens are untouched everywhere else. */}
      <div data-copilotkit className="contents">
        <AssistantPanel />
      </div>
    </CopilotKitProvider>
  );
}
