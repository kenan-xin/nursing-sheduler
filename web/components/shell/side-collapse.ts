// Desktop sidebar collapse preference (G8).
//
// The prototype's `≥920px` rail toggles between the expanded panel and a 60px
// icon rail, persisted in `localStorage` under `ns-side-collapsed` (prototype
// README, "Collapsible sidebar"). DESIGN.md's deviation matrix used to exclude
// the feature; the user has since ratified it, and the matrix row now records
// the shipped 280/60 pair.
//
// TWO authorities, deliberately split, because they are answering different
// questions at different times:
//
//   • WIDTH is the `data-side-collapsed` attribute on <html>. A pre-paint inline
//     script (side-collapse-script.tsx) sets it from storage before the first
//     frame, and globals.css maps it onto `--sidebar-w`. So the rail is never
//     painted at 280px and then snapped to 60px on reload.
//   • CONTENT is this store. It cannot read storage at module init without
//     diverging the first client render from the server's expanded default, so
//     it adopts post-mount exactly like the mode store does.
//
// The store's own actions write BOTH, so the two can never disagree after
// hydration. `data-side-ready` records that adoption has happened; globals.css
// holds the collapsed rail's interior invisible until then, so the one frame
// where a 60px rail still holds server-rendered expanded markup is blank rather
// than visibly clipped.
//
// This file is DOM-and-storage aware but React-free, mirroring lib/mode/mode.ts,
// so it stays unit-testable without a renderer.

import { create } from "zustand";

export const SIDE_COLLAPSE_STORAGE_KEY = "ns-side-collapsed";
export const SIDE_COLLAPSE_ATTRIBUTE = "data-side-collapsed";
export const SIDE_ADOPTED_ATTRIBUTE = "data-side-ready";

export interface SideCollapseState {
  collapsed: boolean;
  /** Whether the persisted preference has been adopted post-mount. */
  adopted: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  /** Idempotent; called once by `useSyncSideCollapse` after reconciliation. */
  markAdopted: () => void;
}

export function createSideCollapseStore(initial: boolean = false) {
  return create<SideCollapseState>((set, get) => ({
    collapsed: initial,
    adopted: false,
    setCollapsed: (collapsed) => {
      set({ collapsed });
      persistSideCollapsed(collapsed);
      applySideCollapsed(collapsed);
    },
    toggleCollapsed: () => {
      const next = !get().collapsed;
      set({ collapsed: next });
      persistSideCollapsed(next);
      applySideCollapsed(next);
    },
    markAdopted: () => {
      set({ adopted: true });
      markSideAdopted();
    },
  }));
}

/**
 * Read the persisted preference. Called AFTER mount by the adoption hook, never
 * at module init — reading it at init would diverge the first client render from
 * the server's expanded default and cause a hydration mismatch.
 *
 * Only the literal `"1"` collapses. Anything else — absent, `"0"`, a stale value
 * from another product, a throwing storage — leaves the rail expanded, which is
 * the state that can never hide navigation from someone who did not ask for it.
 */
export function readStoredSideCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDE_COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistSideCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {}
}

/** Mirror the preference onto <html>, which is the rail's WIDTH authority. */
export function applySideCollapsed(collapsed: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (collapsed) root.setAttribute(SIDE_COLLAPSE_ATTRIBUTE, "1");
  else root.removeAttribute(SIDE_COLLAPSE_ATTRIBUTE);
}

/** Record that React has adopted the stored preference (releases the CSS hold). */
export function markSideAdopted(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(SIDE_ADOPTED_ATTRIBUTE, "1");
}

// Singleton initialized to the fixed expanded default — identical on server and
// in the client hydration render. The stored value is adopted post-mount.
export const useSideCollapseStore = createSideCollapseStore(false);
