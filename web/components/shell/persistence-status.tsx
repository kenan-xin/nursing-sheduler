"use client";

// Persistence status affordance (T08, MAJOR 6). The shell promises browser
// auto-save; this makes that promise observable with an honest, stateful signal
// instead of the old unconditional "is saved" Home footer.
//
// The model has four states mirroring the real T04 write lifecycle:
//   • restoring   — the durable store is hydrating from IndexedDB
//   • saving      — a tracked mutation queued a write that has not yet settled
//   • saved       — the latest queued write completed (prototype green ● SAVED)
//   • error       — the last write/hydration failed and is surfaced, not swallowed
//
// The controller subscribes to the durable scenario store: every `setState` (the
// persist middleware writes on each one) flips to "saving", then drains the
// guarded write queue and inspects `consumeWriteError` to settle "saved"/"error".
// A monotonic token guards against out-of-order settling under rapid edits.

import { useEffect, useRef } from "react";
import { create } from "zustand";
import {
  useHotStore,
  useScenarioStore,
  getScenarioStorage,
  type GuardedStorage,
} from "@/lib/store";
import { cn } from "@/lib/utils";
import { FaSpinner, FaCircleCheck, FaTriangleExclamation } from "@/components/icons";

export type PersistenceStatus = "restoring" | "saving" | "saved" | "error";

interface PersistenceStatusState {
  status: PersistenceStatus;
  setStatus: (status: PersistenceStatus) => void;
}

const usePersistenceStatusStore = create<PersistenceStatusState>((set) => ({
  status: "restoring",
  setStatus: (status) => set({ status }),
}));

/** Synchronous read of the current persistence status (T08b's beforeunload guard
 *  arms on `saving`/`error` alongside a losable draft). */
export function getPersistenceStatus(): PersistenceStatus {
  return usePersistenceStatusStore.getState().status;
}

/**
 * Resolve the durable status for one write cycle against `storage`: await its
 * drain, then read its self-clearing error. Extracted as a standalone async
 * function (T08f) so the controller's newest-revision-wins settle behavior is
 * testable directly against a `GuardedStorage`, without mounting React or a
 * full state spine — `GuardedStorage.setItem` already clears a stale error
 * once a later revision succeeds (lib/store/persistence.ts), so this always
 * reflects the newest write's real outcome, never a superseded failure.
 */
export async function resolveWriteOutcome(
  storage: GuardedStorage | undefined,
): Promise<"saved" | "error"> {
  await storage?.drain();
  return storage?.consumeWriteError() ? "error" : "saved";
}

// Mount ONCE (in the hydration gate). Bridges the durable store's real write
// lifecycle into the persistence-status store.
export function usePersistenceStatusController(): void {
  const hydrationStatus = useHotStore((s) => s.hydrationStatus);
  const settleToken = useRef(0);

  // Map the hydration lifecycle onto the status. On `ready` the restored/blank
  // record is by definition already persisted, so we start at "saved".
  useEffect(() => {
    const set = usePersistenceStatusStore.getState().setStatus;
    if (hydrationStatus === "unhydrated" || hydrationStatus === "hydrating") set("restoring");
    else if (hydrationStatus === "recoverable-error") set("error");
    else set("saved");
  }, [hydrationStatus]);

  // Reflect each durable write. Only while `ready` — a pre-ready set is the
  // hydration replacement itself, which must not read as a user save.
  useEffect(() => {
    const unsubscribe = useScenarioStore.subscribe(() => {
      if (useHotStore.getState().hydrationStatus !== "ready") return;
      const token = ++settleToken.current;
      usePersistenceStatusStore.getState().setStatus("saving");
      void (async () => {
        // Yield so the persist middleware's synchronous setItem is enqueued
        // before we await the drain.
        await Promise.resolve();
        const status = await resolveWriteOutcome(getScenarioStorage(useScenarioStore));
        if (token !== settleToken.current) return; // a newer write superseded us
        usePersistenceStatusStore.getState().setStatus(status);
      })();
    });
    return unsubscribe;
  }, []);
}

const LABEL: Record<PersistenceStatus, string> = {
  restoring: "Restoring",
  saving: "Saving",
  saved: "Saved",
  error: "Save failed",
};

function StatusMark({ status }: { status: PersistenceStatus }) {
  if (status === "restoring" || status === "saving") {
    return <FaSpinner className="size-3 animate-spin-slow text-ink3" aria-hidden />;
  }
  if (status === "error") {
    return <FaTriangleExclamation className="size-3 text-error" aria-hidden />;
  }
  return <FaCircleCheck className="size-3 text-success" aria-hidden />;
}

function toneClass(status: PersistenceStatus): string {
  if (status === "error") return "text-error";
  if (status === "saved") return "text-success";
  return "text-ink3";
}

// Compact top-bar status chip (the "compact secondary status surface" of MAJOR 5).
export function PersistenceStatus() {
  const status = usePersistenceStatusStore((s) => s.status);
  return (
    <span
      data-testid="persistence-status"
      data-status={status}
      role="status"
      className={cn(
        "hidden items-center gap-1.5 text-label uppercase tracking-[0.03em] sm:inline-flex",
        toneClass(status),
      )}
    >
      <StatusMark status={status} />
      {LABEL[status]}
    </span>
  );
}

// Fuller badge for the Save & Load surface — mirrors the prototype's green
// ● SAVED confirmation, but stays honest across the other three states. NOT a
// live region (T08a): the top bar's compact `PersistenceStatus` is the shell's
// one live `role="status"` announcement, so a second live surface on the same
// underlying state would double-announce to assistive tech. This badge is
// static explanatory copy that happens to re-render on status change.
export function PersistenceBadge() {
  const status = usePersistenceStatusStore((s) => s.status);
  return (
    <span
      data-testid="persistence-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 border border-line bg-surface px-3 py-1.5 text-label uppercase tracking-[0.03em]",
        toneClass(status),
      )}
    >
      <StatusMark status={status} />
      {LABEL[status]}
    </span>
  );
}
