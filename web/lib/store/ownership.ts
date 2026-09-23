"use client";

// Writer-lease upkeep and cross-tab notification (T03).
//
// THE DIVISION OF LABOUR. The persisted lease row plus the IndexedDB transaction
// that checks it is the AUTHORITY. Everything in this module is upkeep and
// notification around that authority:
//
//   • the heartbeat renews the lease so a live owner stays obviously live, and its
//     FAILURE is how a taken-over or expired tab learns it must stop writing;
//   • BroadcastChannel tells peers something changed, so a read-only tab updates
//     within a frame instead of within a heartbeat.
//
// A hint is never trusted. Every message triggers an authoritative REREAD, and
// every write still re-checks the lease inside its own transaction. That is what
// keeps a frozen or disconnected former owner — which by definition never receives
// a hint — correctly fenced: its next persisted write fails the epoch check.
//
// Correspondingly, this module is never a fallback: if BroadcastChannel is absent,
// nothing about correctness changes, only latency.

import { useEffect } from "react";
import { LEASE_HEARTBEAT_MS } from "@/lib/repository";
import type { OwnershipHint } from "./authority";
import { getScenarioAuthority, setOwnershipBroadcast } from "./spine";

/** The cross-tab hint channel. Advisory notifications only — never authority. */
export const OWNERSHIP_CHANNEL_NAME = "nurse-scheduler/ownership";

function isOwnershipHint(value: unknown): value is OwnershipHint {
  if (typeof value !== "object" || value === null) return false;
  const hint = value as Record<string, unknown>;
  return (
    (hint.kind === "acquired" || hint.kind === "released" || hint.kind === "committed") &&
    typeof hint.scenarioId === "string" &&
    typeof hint.tabId === "string" &&
    typeof hint.epoch === "number"
  );
}

/**
 * Mount the lease heartbeat and the cross-tab hint channel. Mounted ONCE, in the
 * hydration gate, alongside the other app-lifetime controllers.
 *
 * The heartbeat runs unconditionally rather than being started and stopped as
 * ownership changes: `heartbeat()` is a no-op without a lease, and a timer that
 * only exists while we believe we are the owner cannot notice that we no longer
 * are. Deriving the loss from the renewal's own failure is what makes an expiry
 * observable in a tab that was suspended.
 */
export function useOwnershipController(): void {
  useEffect(() => {
    const authority = getScenarioAuthority();

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(OWNERSHIP_CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (isOwnershipHint(event.data)) void authority.onHint(event.data);
      };
      setOwnershipBroadcast((hint) => channel?.postMessage(hint));
    }

    const timer = setInterval(() => {
      void authority.heartbeat();
    }, LEASE_HEARTBEAT_MS);

    return () => {
      clearInterval(timer);
      setOwnershipBroadcast(() => {});
      channel?.close();
    };
  }, []);
}
