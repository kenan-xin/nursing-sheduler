"use client";

// The ownership and identity triggers of the interruption controller (T05).
//
// Stop, Disable, Remove/Replace and the two Clears are all things the USER asks for,
// so they have a control to hang off. Scenario switch, lease loss and takeover are
// not: they happen TO this tab, asynchronously, and the only evidence is the
// authority projection changing underneath it. This hook is that evidence turned into
// the same one controller call every other trigger uses.
//
// IT WATCHES THE PROJECTION, NOT THE LEASE ROW, and that is correct here even though
// a send's gate must do the opposite. The pre-send gate reads persisted state because
// it must not be fooled by a delayed hint; this hook needs the moment ownership
// CHANGED, and `ScenarioAuthority` publishes exactly that after it has already
// reconciled against durable truth. A projection change is therefore a fact that has
// happened, not a guess -- and any send racing it is refused by the persisted read
// anyway.
//
// IT ONLY FIRES WHEN THERE IS LIVE WORK. With no active turn there are no callbacks
// to fence and no stream to abort, and announcing a settlement the user never started
// would be noise. Read-only rendering after a takeover is the panel's job and happens
// regardless.

import { useEffect } from "react";
import { useAuthorityStore, type ScenarioOwnership } from "@/lib/store";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import type { InterruptionTrigger } from "@/lib/ai/assistant/lifecycle";

/**
 * Which trigger an ownership transition is, or `null` when it is not a loss.
 *
 * `taken-over` and `expired` are deliberately kept apart: the flow tells the user
 * different things ("another tab took over" vs "this tab's claim expired"), and the
 * turn record keeps the distinction. Falling to `read-only` is an expiry from this
 * tab's point of view -- the lease is simply somebody else's now.
 */
export function ownershipLossTrigger(
  previous: ScenarioOwnership,
  next: ScenarioOwnership,
): InterruptionTrigger | null {
  if (previous !== "owner" || next === "owner") return null;
  return next === "taken-over" ? "takeover" : "lease_lost";
}

/** Subscribe to the authority projection and interrupt on identity/ownership loss. */
export function useInterruptionWatch(): void {
  useEffect(() => {
    let previous = useAuthorityStore.getState();

    return useAuthorityStore.subscribe((next) => {
      const before = previous;
      previous = next;

      // Nothing in flight means nothing to interrupt. Checked against the live store
      // rather than captured, because a turn may have started since subscribing.
      if (useAssistantStore.getState().activeTurnId === null) return;

      if (before.scenarioId !== null && next.scenarioId !== before.scenarioId) {
        // Scoped to the PREVIOUS identity: the work being interrupted belongs to the
        // document that was just switched away from, and its thread is that one's.
        void assistantActions.interrupt({
          trigger: "scenario_switch",
          threadId: null,
          scenarioId: before.scenarioId,
        });
        return;
      }

      const trigger = ownershipLossTrigger(before.ownership, next.ownership);
      if (trigger) {
        void assistantActions.interrupt({
          trigger,
          threadId: null,
          scenarioId: next.scenarioId,
        });
      }
    });
  }, []);
}
