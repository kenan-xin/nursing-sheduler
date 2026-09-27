"use client";

// bd nursing-sheduler-6t1y — the in-shell error state shared by the two boundaries
// (`app/(app)/error.tsx` and `app/global-error.tsx`).
//
// A screen that crashes must not hand the user Next's bare error page. For the
// (app) boundary the shell stays mounted around this, because that file is
// rendered INSIDE `app/(app)/layout.tsx`'s AppShell; only the crashing screen's
// own content is replaced, so the sidebar and navigation remain visible and usable.
//
// There is no error-state design in DESIGN.md (the ticket says so explicitly), so
// this reuses the repo's canonical NOTICE pattern rather than inventing a new
// visual language: the `Callout` in its `error` tone at `page` placement.
//   • `page` is the ladder-correct mount for a callout seated directly on the L0
//     content plane (DESIGN.md §4; see the Callout header), which is exactly where
//     a crashed route's cards would have been.
//   • the `error` tone pairs its `--errortint` fill with `--errorink` text and an
//     `--error` border — the Redundant Signal Rule, §2 — and is the tone the repo
//     already reserves for "something went wrong".
// `alert` announces the state to assistive tech; the actions row carries the Retry.
//
// The copy is decided here (there was none to inherit) and recorded in bd memory
// `minor-decisions-delegated`.

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/optimize/callout";

/** Default title for a crashed route. Short and plain, in the app's notice voice. */
export const SCREEN_ERROR_TITLE = "This screen could not load";
/** Default body. Says what happened, and that the rest of the app is unaffected. */
export const SCREEN_ERROR_MESSAGE =
  "Something went wrong while showing this page. Your other work is safe.";

export interface ScreenErrorProps {
  /** Retry handler — wired to the error boundary's `reset()`. */
  onRetry: () => void;
  title?: string;
  message?: string;
}

export function ScreenError({
  onRetry,
  title = SCREEN_ERROR_TITLE,
  message = SCREEN_ERROR_MESSAGE,
}: ScreenErrorProps) {
  return (
    // Horizontally centred and held to a readable measure: a full-width banner at
    // the shell's 1240px cap reads as a stray strip, not a screen state. `pt-8`
    // drops it clear of the top bar without competing with the shell's own padding.
    <div className="flex justify-center pt-8">
      <Callout
        tone="error"
        placement="page"
        alert
        data-testid="app-error-state"
        className="w-full max-w-[560px]"
        title={title}
        actions={
          <Button onClick={onRetry} data-testid="app-error-retry">
            Retry
          </Button>
        }
      >
        {message}
      </Callout>
    </div>
  );
}
