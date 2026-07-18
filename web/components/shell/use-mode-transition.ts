"use client";

// Mode-transition transaction (T08c). A mode change is not a bare `setMode`:
// it must first decide whether the CURRENT route survives in the target mode,
// then — only when a route change would actually unmount something — stage
// the change through the shared navigation-intent guard so an open losable
// draft is never discarded silently. Cancel changes neither mode nor route.
//
// When the target mode keeps the current route valid (true for every shipped
// route today — see route-registry.ts), there is nothing to unmount, so the
// mode commits immediately regardless of any open draft: toggling the lens
// never touches the scenario store, so no work is at risk. This preserves the
// segmented control's existing click/keyboard behavior exactly — the guard
// dialog only starts to matter once T08d makes some routes Advanced-only and
// a Guided switch would redirect away from one.
//
// `onCommitted` (T08f P2) reports when the mode ACTUALLY changed — immediately
// today (nothing ever stages), but only after Confirm once T08d introduces an
// invalid-route redirect. The caller (mode-toggle's roving-tab focus) must
// move focus to the target tab from this callback, never eagerly: moving it
// on the mere request would leave focus on the not-yet-selected tab if the
// transition is later canceled, breaking the roving-tabindex invariant.

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useModeStore, type AppMode } from "@/lib/mode/mode";
import { dispatchNavIntent } from "./nav-guard-store";
import { isRouteValidForMode } from "./route-registry";

export interface ModeTransition {
  /** Request switching to `target`. No-op if already in that mode.
   *  `onCommitted` runs only once the mode has actually changed — immediately
   *  when the current route survives, or after Confirm when it doesn't. It
   *  never runs on Cancel. */
  requestModeChange: (target: AppMode, onCommitted?: () => void) => void;
}

export function useModeTransition(): ModeTransition {
  const router = useRouter();
  const pathname = usePathname();

  const requestModeChange = useCallback(
    (target: AppMode, onCommitted?: () => void) => {
      if (useModeStore.getState().mode === target) return;

      // Advanced-only → Guided lands on Home via `replace`, never `push`
      // (DL12): it's a lens correction, not a new place in history.
      const targetPath = isRouteValidForMode(pathname, target) ? pathname : "/";
      const commit = () => {
        useModeStore.getState().setMode(target);
        if (targetPath !== pathname) router.replace(targetPath);
        onCommitted?.();
      };

      if (targetPath === pathname) {
        // The route survives the switch — nothing is unmounted, so there is
        // no losable-draft risk to guard against.
        commit();
        return;
      }
      dispatchNavIntent({ kind: "mode-transition", commit });
    },
    [router, pathname],
  );

  return { requestModeChange };
}
