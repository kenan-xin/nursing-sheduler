"use client";

// Reading the LIVE capability context (T06).
//
// A plain function rather than a hook, deliberately. Tool handlers run
// asynchronously, potentially long after the render that registered them, so a hook
// value captured at registration would be a snapshot of the mode and gates as they
// were when the panel mounted. Every handler therefore calls this at invocation time
// and resolves against what is true now.
//
// `modeResolved` is carried rather than assumed: the mode store renders the Guided
// default on the server and adopts the persisted preference after mount, so an
// Advanced user's stored preference is briefly not yet in effect. Resolving during
// that window would hide every Advanced capability, so the resolver refuses instead.

import { selectReady, useAssistantStore } from "@/lib/ai/assistant/store";
import { resolveFeatureGates } from "@/lib/capability/gates";
import type { CapabilityContext } from "@/lib/capability/resolve";
import type { CapabilityRegistryStamp } from "@/lib/capability/types";
import { useModeStore } from "@/lib/mode/mode";

/**
 * The current mode, gates and adoption state.
 *
 * @param stamp The registry identity an earlier answer was produced under, when
 *   re-checking a decision. Omit for a fresh resolution.
 */
export function readCapabilityContext(stamp?: CapabilityRegistryStamp): CapabilityContext {
  const modeState = useModeStore.getState();
  const assistantState = useAssistantStore.getState();
  return {
    mode: modeState.mode,
    modeResolved: modeState.adoption === "ready",
    gates: resolveFeatureGates({ assistantReady: selectReady(assistantState) }),
    ...(stamp ? { stamp } : {}),
  };
}
