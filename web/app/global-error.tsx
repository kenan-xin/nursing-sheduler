"use client";

// bd nursing-sheduler-6t1y — the root global error boundary.
//
// Next renders this file ONLY when the ROOT layout itself throws: a crash in
// `(app)/layout.tsx` (the AppShell) or in `app/layout.tsx`. It is the case
// `app/(app)/error.tsx` cannot cover, because a segment's `error.tsx` never wraps
// the layout above its own segment. The docs recommend it for exactly this: "For
// errors in the root layout, global-error.js should be used."
//
// It REPLACES the root layout, so it must render its own <html>/<body> and pull
// in its own global styles — the docs state it "requires its own <html> and
// <body> tags, along with any necessary global styles, fonts, or other
// dependencies". The shell cannot be kept here: the shell IS the layout that
// failed. This is a last-resort page, not the in-shell screen state.
//
// API: Next 16.2.10 passes `error`, `reset` and `unstable_retry`; Retry is wired
// to `reset()`, matching the (app) boundary. Console only — no external telemetry.

import { useEffect } from "react";
import "./globals.css";
import { ScreenError } from "@/components/shell/screen-error";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <main className="flex min-h-dvh items-center justify-center px-5">
          <ScreenError
            onRetry={reset}
            title="Something went wrong"
            message="The app hit an unexpected error and could not finish loading."
          />
        </main>
      </body>
    </html>
  );
}
