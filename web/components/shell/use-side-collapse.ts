// React bindings for the desktop sidebar collapse preference (G8). A tiny hook
// set that adopts the persisted value on mount and writes on change, keeping the
// store itself renderer-free so unit tests stay pure. Mirrors lib/mode/use-mode.

"use client";

import { useEffect } from "react";
import { useSideCollapseStore, readStoredSideCollapsed } from "./side-collapse";

/** Whether the DESKTOP rail is compact. The mobile drawer never reads this. */
export function useSideCollapsed(): boolean {
  return useSideCollapseStore((s) => s.collapsed);
}

export function useSideCollapseActions() {
  const setCollapsed = useSideCollapseStore((s) => s.setCollapsed);
  const toggleCollapsed = useSideCollapseStore((s) => s.toggleCollapsed);
  return { setCollapsed, toggleCollapsed };
}

/**
 * Adopt the persisted preference ONCE, after mount.
 *
 * SSR and the first client render both show the expanded default (store init),
 * so hydration matches; only after commit is a stored collapsed value applied —
 * one reconciliation render, no mismatch. The pre-paint script has already put
 * the right WIDTH on <html>, so this reconciliation swaps content inside an
 * already-correct box rather than resizing anything.
 *
 * `markAdopted` runs whether or not the stored value differed, so the CSS hold
 * on the collapsed rail's interior is released exactly once per mount.
 * Call once near the root of the client tree (the app shell).
 */
export function useSyncSideCollapse(): void {
  useEffect(() => {
    const stored = readStoredSideCollapsed();
    if (stored !== useSideCollapseStore.getState().collapsed) {
      useSideCollapseStore.getState().setCollapsed(stored);
    }
    useSideCollapseStore.getState().markAdopted();
  }, []);
}
