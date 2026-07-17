"use client";

// Guarded navigation (T08 / FR-PR-06). Every in-app navigation path — nav links,
// the mobile sheet, programmatic pushes — routes through `navigate()`. When no
// card-editor draft is open it pushes immediately; when a draft is open it defers
// to the shared nav-guard store, which opens the single confirm dialog rendered by
// the AppShell. The shell resolves the pending push on confirm.
//
// Scope note (qq0.21): the guard fires ONLY on an open draft, NOT on a merely
// "dirty" scenario. Scenario mutations auto-persist to IndexedDB (T04) so they
// cannot be lost on navigation; the "unsaved-to-YAML" meaning of dirty belongs to
// the not-yet-built Save/Load feature (spec §08). With no Save UI, `markSaved` is
// never called, so scenario-`dirty` latched true after the first edit and armed
// this guard on every click. The whole-scenario "leave without saving?" warning
// (T08 acceptance row 2) is deferred to qq0.22 and re-enabled once Save/Load can
// actually clear dirty. T04's dirty machinery (`selectIsDirty` / persisted
// baseline) stays intact for that.
//
// A browser-level `beforeunload` guard (refresh / tab close / external nav) is a
// separate hook, `useDirtyBeforeUnload`, mounted once in the shell — the in-app
// confirm cannot intercept those.

import { useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useNavGuardStore } from "./nav-guard-store";

export interface GuardedNavigation {
  /** Attempt to navigate to `path`; shows the guard first if a card-editor draft is open. */
  navigate: (path: string) => void;
}

export function useGuardedNavigation(): GuardedNavigation {
  const router = useRouter();
  const pathname = usePathname();
  const requestGuard = useNavGuardStore((s) => s.requestGuard);

  const navigate = useCallback(
    (path: string) => {
      // Same-route clicks are no-ops.
      if (path === pathname) return;

      // Guard only on an open card-editor draft (FR-PR-06): an open add/edit form
      // holds unsaved work that isn't a durable mutation yet. A dirty-but-no-draft
      // scenario navigates freely — see the scope note above (qq0.21 / qq0.22).
      const draftOpen = useNavGuardStore.getState().draftOpen;
      if (!draftOpen) {
        router.push(path);
        return;
      }

      requestGuard(path);
    },
    [router, pathname, requestGuard],
  );

  return { navigate };
}

// Browser-level guard: warns before refresh / tab close / external nav while a
// card-editor draft is open (FR-PR-06). It mirrors the in-app nav guard's
// condition — draft-only, NOT scenario-`dirty` — because scenario mutations
// auto-persist to IndexedDB (T04) and cannot be lost on leave, whereas an open
// draft is not yet committed. The whole-scenario dirty warning is deferred with
// the in-app guard (qq0.21 / qq0.22). The native prompt string is
// browser-controlled; setting `returnValue` is what triggers it.
export function useDirtyBeforeUnload(): void {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useNavGuardStore.getState().draftOpen) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
