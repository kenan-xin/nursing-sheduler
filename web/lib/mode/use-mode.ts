// React bindings for the mode lens (T08). A tiny hook + provider that adopts the
// persisted mode preference on mount and writes on change, keeping the Zustand
// store itself DOM-free so unit tests stay pure.

"use client";

import { useEffect } from "react";
import { useModeStore, readStoredMode, type AppMode, type ModeAdoption } from "./mode";

export function useAppMode(): AppMode {
  return useModeStore((s) => s.mode);
}

/** T08c: whether the persisted mode preference has been adopted yet. A
 *  route-validity gate (T08d) must wait for `"ready"` before redirecting, so a
 *  stored Advanced preference is never bounced by the initial Guided default. */
export function useModeAdoption(): ModeAdoption {
  return useModeStore((s) => s.adoption);
}

export function useModeActions() {
  const setMode = useModeStore((s) => s.setMode);
  const toggleMode = useModeStore((s) => s.toggleMode);
  return { setMode, toggleMode };
}

// Adopts the persisted mode preference ONCE, after mount. SSR and the first client
// render both show the Guided default (store init), so hydration matches; only
// after commit do we apply a stored Advanced value — one reconciliation render,
// no mismatch. `setMode` write-through re-persists the same value (idempotent), so
// nothing is clobbered. Ongoing changes persist via the store actions themselves.
// Call once near the root of the client tree (inside the shell layout).
//
// `markAdopted` runs after reconciling — regardless of whether the stored value
// differed from the default — so `useModeAdoption()` flips to `"ready"` exactly
// once per mount, whether or not the preference actually changed.
export function useSyncModePersistence(): void {
  useEffect(() => {
    const stored = readStoredMode();
    if (stored !== useModeStore.getState().mode) {
      useModeStore.getState().setMode(stored);
    }
    useModeStore.getState().markAdopted();
  }, []);
}
