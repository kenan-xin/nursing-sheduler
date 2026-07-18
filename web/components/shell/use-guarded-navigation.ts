"use client";

// Guarded navigation (T08 / FR-PR-06). Every in-app navigation path — nav links,
// the mobile sheet, programmatic pushes — routes through `navigate()`. When no
// card-editor draft is open it pushes immediately; when a draft is open it defers
// to the shared nav-guard store, which opens the single confirm dialog rendered by
// the AppShell. The shell resolves the pending push on confirm.
//
// Scope note (qq0.22): the guard fires on an open draft OR a "dirty" scenario.
// The scenario-`dirty` branch was narrowed out in qq0.21 because Save/Load (spec
// §08) was unbuilt — `markSaved` had no caller, so `selectIsDirty` latched true
// after the first edit and armed the guard on every click. T17 shipped Save/Load:
// a YAML Download now calls `markSaved` and a Load resets the baseline, so dirty
// can return to clean, and the whole-scenario "leave without saving?" warning
// (T08 acceptance row 2) is re-enabled here. Scenario edits still auto-persist to
// IndexedDB (T04) — the warning is about unsaved-to-YAML, not data loss.
//
// A browser-level `beforeunload` guard (refresh / tab close / external nav) is a
// separate hook, `useDirtyBeforeUnload`, mounted once in the shell — the in-app
// confirm cannot intercept those.

import { useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { selectIsDirty, useScenarioStore } from "@/lib/store";
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

      // Guard on either an open card-editor draft (FR-PR-06 — unsaved work not yet
      // a durable mutation) OR a scenario that is dirty against the last explicit
      // Save/Load baseline (T08 acceptance row 2, re-enabled in qq0.22 now that
      // T17's YAML Download wires `markSaved` and Load resets the baseline, so
      // `selectIsDirty` can actually return to clean). Otherwise navigate freely.
      const draftOpen = useNavGuardStore.getState().draftOpen;
      const dirty = selectIsDirty(useScenarioStore.getState());
      if (!draftOpen && !dirty) {
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
// card-editor draft is open (FR-PR-06) OR the scenario is dirty vs the last
// explicit Save/Load baseline (T08 row 2, re-enabled qq0.22). It mirrors the
// in-app nav guard's condition. Scenario edits auto-persist to IndexedDB (T04),
// so the warning is about unsaved-to-YAML, not data loss. The native prompt
// string is browser-controlled; setting `returnValue` is what triggers it.
export function useDirtyBeforeUnload(): void {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useNavGuardStore.getState().draftOpen || selectIsDirty(useScenarioStore.getState())) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
