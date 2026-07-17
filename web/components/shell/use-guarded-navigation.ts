"use client";

// Guarded navigation (T08, acceptance row 2). Every in-app navigation path — nav
// links, the mobile sheet, programmatic pushes — routes through `navigate()`.
// When the scenario is clean it pushes immediately; when dirty it defers to the
// shared nav-guard store, which opens the single confirm dialog rendered by the
// AppShell. The shell resolves the pending push on confirm.
//
// A browser-level `beforeunload` guard (refresh / tab close / external nav) is a
// separate hook, `useDirtyBeforeUnload`, mounted once in the shell — the in-app
// confirm cannot intercept those.

import { useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { selectIsDirty, useScenarioStore } from "@/lib/store";
import { useNavGuardStore } from "./nav-guard-store";

export interface GuardedNavigation {
  /** Attempt to navigate to `path`; shows the guard first if the scenario is dirty. */
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

      // Guard on a dirty scenario OR an open card-editor draft (FR-PR-06): an open
      // add/edit form holds unsaved work that isn't a durable mutation yet.
      const dirty = selectIsDirty(useScenarioStore.getState());
      const draftOpen = useNavGuardStore.getState().draftOpen;
      if (!dirty && !draftOpen) {
        router.push(path);
        return;
      }

      requestGuard(path);
    },
    [router, pathname, requestGuard],
  );

  return { navigate };
}

// Browser-level dirty guard: warns before refresh / tab close / external nav when
// the scenario has unsaved changes. Pairs with T04's pagehide persist (which keeps
// the data safe) — this adds the explicit "leave without saving?" prompt row 2
// expects. The native prompt string is browser-controlled; setting `returnValue`
// is what triggers it.
export function useDirtyBeforeUnload(): void {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (selectIsDirty(useScenarioStore.getState()) || useNavGuardStore.getState().draftOpen) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
