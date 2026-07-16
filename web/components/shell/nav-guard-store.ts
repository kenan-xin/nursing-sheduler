"use client";

// Shared dirty-navigation guard state (T08, acceptance row 2).
//
// The guard is consulted from many places — sidebar links, the mobile sheet, any
// programmatic navigation — but the confirm dialog it drives is rendered ONCE in
// the AppShell. A per-hook `useState` cannot bridge those: each caller would own a
// private copy, so a sidebar click would flip its own flag while the shell's
// dialog watched a different one and never opened. A module-level store gives one
// source of truth every consumer reads and writes.
//
// This store holds only the pending destination + open flag; the actual
// `router.push` stays in the shell (which owns the Next router) so the store has
// no router dependency and remains trivially testable.

import { create } from "zustand";

interface NavGuardState {
  /** The route the user is trying to reach, held while the confirm is open. */
  pendingPath: string | null;
  /** Whether the dirty-nav confirm dialog is currently shown. */
  open: boolean;
  /** Intercept a navigation to `path`: stash it and open the confirm. */
  requestGuard: (path: string) => void;
  /** Dismiss the confirm without navigating (Stay / backdrop / Esc). */
  cancel: () => void;
  /** Clear guard state after the navigation has been committed. */
  clear: () => void;
}

export const useNavGuardStore = create<NavGuardState>((set) => ({
  pendingPath: null,
  open: false,
  requestGuard: (path) => set({ pendingPath: path, open: true }),
  cancel: () => set({ pendingPath: null, open: false }),
  clear: () => set({ pendingPath: null, open: false }),
}));
