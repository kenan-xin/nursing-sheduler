"use client";

// bd nursing-sheduler-6t1y — the (app) route-group error boundary.
//
// Catches a crash in any product screen's page or nested layout and replaces ONLY
// that content. Next renders this file INSIDE `app/(app)/layout.tsx`, so the
// AppShell (sidebar, top bar, navigation, toasts) stays mounted and usable around
// it. It does NOT catch a crash in `(app)/layout.tsx` itself — Next's docs are
// explicit that `error.tsx` "does not wrap the layout.js ... above it in the same
// segment"; an AppShell crash bubbles to `app/global-error.tsx`.
//
// API, verified against the INSTALLED version rather than from memory: Next
// 16.2.10 passes this component `error`, `reset` AND `unstable_retry`
// (`next/dist/client/components/error-boundary.js`; `ErrorInfo` in the sibling
// `.d.ts`). Retry is wired to `reset()` as the ticket specifies — it clears the
// boundary state and re-renders the segment, which is the recovery for the
// client-render crashes these screens throw. `unstable_retry()` additionally runs
// `router.refresh()`; see the bead notes for why `reset()` was kept.
//
// The error is logged to the console ONLY — no external telemetry.

import { useEffect } from "react";
import { ScreenError } from "@/components/shell/screen-error";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <ScreenError onRetry={reset} />;
}
