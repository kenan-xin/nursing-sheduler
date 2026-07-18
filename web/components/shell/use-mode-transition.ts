"use client";

// Mode-transition transaction (T08c; T08d activates the real route-validity
// check and adds the inverse Guided→Advanced transition). A mode change is not
// a bare `setMode`: it must first decide whether the target route survives in
// the target mode, then — only when a route change would actually unmount
// something — stage the change through the shared navigation-intent guard so
// an open losable draft is never discarded silently. Cancel changes neither
// mode nor route.
//
// When the target mode keeps the target route valid, there is nothing to
// unmount, so the mode commits immediately regardless of any open draft:
// toggling the lens never touches the scenario store, so no work is at risk.
// The guard dialog only stages once a route actually becomes invalid for the
// target mode — an Advanced-only route switching to Guided, or "Edit in
// Advanced" navigating away from an open draft.
//
// `onCommitted` (T08f P2) reports when the mode ACTUALLY changed — immediately
// when the target route survives, or only after Confirm when it doesn't. The
// caller (mode-toggle's roving-tab focus) must move focus to the target tab
// from this callback, never eagerly: moving it on the mere request would
// leave focus on the not-yet-selected tab if the transition is later
// canceled, breaking the roving-tabindex invariant.
//
// `onCancelled` (T08d repair P2) is the Cancel-path counterpart: a pointer
// click focuses the clicked (target) tab before its `onClick` even runs, so a
// cancelled transition would otherwise strand DOM focus on the still-unselected
// tab. It only ever fires when the transition was staged (an open draft made a
// route change unmountable) — never when it committed immediately.

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useModeStore, type AppMode } from "@/lib/mode/mode";
import { dispatchNavIntent } from "./nav-guard-store";
import { isRouteValidForMode } from "./route-registry";

export interface ModeTransition {
  /** Request switching to `target`. No-op if already in that mode.
   *  `onCommitted` runs only once the mode has actually changed — immediately
   *  when the current route survives, or after Confirm when it doesn't. It
   *  never runs on Cancel. `onCancelled` runs only when the transition was
   *  staged and the user then cancels — never on an immediate commit. */
  requestModeChange: (target: AppMode, onCommitted?: () => void, onCancelled?: () => void) => void;
  /** DL12 §2 step 5: a Guided rule's "Edit in Advanced" action — switch to
   *  `target` and land on `route`, as one draft-guarded transaction. Unlike
   *  `requestModeChange`, this always navigates to `route` even when `target`
   *  is already the current mode (e.g. Rules is reachable from Advanced too). */
  requestModeChangeToRoute: (
    target: AppMode,
    route: string,
    onCommitted?: () => void,
    onCancelled?: () => void,
  ) => void;
}

export function useModeTransition(): ModeTransition {
  const router = useRouter();
  const pathname = usePathname();

  const transition = useCallback(
    (target: AppMode, targetPath: string, onCommitted?: () => void, onCancelled?: () => void) => {
      if (useModeStore.getState().mode === target && targetPath === pathname) return;

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
      dispatchNavIntent({ kind: "mode-transition", commit, onCancel: onCancelled });
    },
    [router, pathname],
  );

  const requestModeChange = useCallback(
    (target: AppMode, onCommitted?: () => void, onCancelled?: () => void) => {
      if (useModeStore.getState().mode === target) return;
      // Advanced-only → Guided lands on Home via `replace`, never `push`
      // (DL12): it's a lens correction, not a new place in history.
      const targetPath = isRouteValidForMode(pathname, target) ? pathname : "/";
      transition(target, targetPath, onCommitted, onCancelled);
    },
    [pathname, transition],
  );

  const requestModeChangeToRoute = useCallback(
    (target: AppMode, route: string, onCommitted?: () => void, onCancelled?: () => void) => {
      transition(target, route, onCommitted, onCancelled);
    },
    [transition],
  );

  return { requestModeChange, requestModeChangeToRoute };
}
