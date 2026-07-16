// Guided/Advanced mode lens (T08, DL10).
//
// The mode toggle is a NON-MUTATING, lossless lens over the scenario: toggling
// between Guided and Advanced changes only how the UI presents the model, never
// the model itself. The durable scenario store (T04) is untouched — no
// reserialize, no flatten, no drop of Advanced-only detail. This file holds the
// lightest possible state (a single enum) so the acceptance row "toggle ⇒ store
// byte-identical" is structurally guaranteed: there is no code path from the
// mode store to the scenario store.
//
// The store is intentionally separate from T04's Zustand stores (no import of
// lib/store/**). Persistence is a write-through side effect of the store actions
// (guarded for SSR), and adoption of the stored value happens AFTER mount via the
// hook — so the store never reads localStorage at module init. That is what keeps
// SSR and the first client render identical (both Guided default): a persisted
// Advanced value is adopted only post-hydration, mirroring the theme store's
// getServerSnapshot/adopt pattern, so there is no hydration mismatch.

import { create } from "zustand";

export type AppMode = "guided" | "advanced";

export interface ModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
}

export function createModeStore(initial: AppMode = "guided") {
  return create<ModeState>((set, get) => ({
    mode: initial,
    setMode: (mode) => {
      set({ mode });
      persistMode(mode);
    },
    toggleMode: () => {
      const next: AppMode = get().mode === "guided" ? "advanced" : "guided";
      set({ mode: next });
      persistMode(next);
    },
  }));
}

export const MODE_STORAGE_KEY = "ns-app-mode";

// Read the persisted preference. Called AFTER mount by the adoption hook, never
// at module init — reading it at init would diverge the first client render from
// the server's Guided default and cause a hydration mismatch.
export function readStoredMode(): AppMode {
  if (typeof window === "undefined") return "guided";
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    return v === "advanced" ? "advanced" : "guided";
  } catch {
    return "guided";
  }
}

export function persistMode(mode: AppMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {}
}

// Singleton initialized to the fixed Guided default — identical on server and in
// the client hydration render. The stored value is adopted post-mount.
export const useModeStore = createModeStore("guided");
