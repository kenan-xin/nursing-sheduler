"use client";

// Route-validity gate for direct URL visits (T08d, tech-plan §2). A bookmarked
// or typed Advanced-only URL must redirect to Home once the persisted mode
// preference has finished adopting — but never before: gating on the
// transient server-default Guided render would bounce a stored Advanced
// preference off its own Advanced-only URL before that preference has even
// been read (`useModeAdoption` only reports "ready" after
// `useSyncModePersistence`'s post-mount reconciliation).
//
// This is independent of `useModeTransition`'s transaction: that seam fires
// when the user actively switches modes via the toggle. This gate fires when
// the current route and the already-settled mode simply disagree — a direct
// visit, or a stored Advanced preference finishing adoption while the current
// route happens to be Advanced-only under the stale Guided default. Routing
// the redirect through the shared guarded `replace` (rather than a bare
// `router.replace`) keeps it consistent with every other navigation surface,
// though in practice no losable draft can be open this early (the gate runs
// on mount/pathname change, before any editor has had a chance to register
// one).

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAppMode, useModeAdoption } from "@/lib/mode/use-mode";
import { useGuardedNavigation } from "./use-guarded-navigation";
import { isRouteValidForMode } from "./route-registry";

export function useRouteValidityGate(): void {
  const pathname = usePathname();
  const mode = useAppMode();
  const adoption = useModeAdoption();
  const { replace } = useGuardedNavigation();

  useEffect(() => {
    if (adoption !== "ready") return;
    if (isRouteValidForMode(pathname, mode)) return;
    replace("/");
  }, [adoption, mode, pathname, replace]);
}
