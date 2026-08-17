"use client";

// Hydration gate + continuity (T08). On client mount this runs the T04
// hydration lifecycle (hydrateScenarioStore), registers the pagehide flush so
// pending writes survive a tab-close, and drives the undo/redo shortcuts. Until
// the store reports `ready` (or `recoverable-error`) the shell shows a skeleton
// so the user never sees the empty default before the persisted record loads
// (tech-plan §4 hydration protocol).
//
// INTEGRATION: the T03 cutover replaced the persist bring-up with repository
// authority (`initializeScenarioAuthority` + `registerScenarioLifecycle` +
// `useOwnershipController`/`OwnershipBanner`), while G4.1's roster-aware reset stays
// the recovery affordance. Both survive: the lifecycle below is T03's, and the reset
// it offers is still the full `resetToNewSchedule`, not the scenario-only one.
//
// `recoverable-error` (corrupt IndexedDB record) surfaces a reset affordance.
//
// G4.1 — that affordance goes through the SAME production `resetToNewSchedule` the
// Save & Load card uses, not the scenario-only reset it used to call. A corrupt
// scenario record is not an exception to the reset contract: the working roster,
// candidates, submission snapshots, capture state and session/marker residue all
// carry real nurse identities and all belong to the previous run, so recovering
// here without them would drop the user into a supposedly new schedule that still
// shows the last run's capture notice. It fails closed for the same reason: being
// blocked on an unverified purge is honest, and claiming `New schedule created`
// over surviving real-identity data is not. The recovery surface stays on screen,
// so the retry is the same button.

import { useEffect, useState } from "react";
import {
  initializeScenarioAuthority,
  registerScenarioLifecycle,
  useHotStore,
  useOwnershipController,
} from "@/lib/store";
import { OwnershipBanner } from "./ownership-banner";
import { NEW_SCHEDULE_FAILED_MESSAGE, resetToNewSchedule } from "@/lib/roster";
import { SkeletonCard } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "./confirm-dialog";
import { useUndoRedoShortcuts } from "./undo-redo-controls";
import { usePersistenceStatusController } from "./persistence-status";
import { useSyncModePersistence } from "@/lib/mode/use-mode";
import { useRouteValidityGate } from "./use-route-validity-gate";
import { toast } from "sonner";

export interface HydrationGateProps {
  children: React.ReactNode;
  /**
   * Test seam for the reset authority, matching `StartOverCard`'s. Production uses
   * the real one; a proof drives the unverified-cleanup branch through this without
   * breaking the browser's storage.
   */
  resetNewSchedule?: typeof resetToNewSchedule;
}

export function HydrationGate({ children, resetNewSchedule }: HydrationGateProps) {
  const hot = useHotStore;
  const status = useHotStore((s) => s.hydrationStatus);
  const [resetOpen, setResetOpen] = useState(false);
  const reset = resetNewSchedule ?? resetToNewSchedule;

  // One-shot bring-up (T03): migrate the legacy record, reread this tab's persisted
  // selection and lease, acquire when free, and register the page-lifecycle listeners
  // that keep this tab's authority honest across BFCache, visibility restore, and
  // reconnect.
  //
  // INTEGRATION: this replaces the pre-T03 `hydrateScenarioStore` + `pagehide` flush.
  // There is no write-behind to flush any more — a command's own transaction IS the
  // write — so `pagehide` now RELEASES the lease instead, which is what
  // `registerScenarioLifecycle` owns.
  useEffect(() => {
    void initializeScenarioAuthority(hot);
    return registerScenarioLifecycle();
  }, [hot]);

  useOwnershipController();
  useUndoRedoShortcuts();
  usePersistenceStatusController();
  useSyncModePersistence();
  useRouteValidityGate();

  if (status === "unhydrated" || status === "hydrating") {
    return (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8"
        data-testid="hydration-loading"
      >
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (status === "recoverable-error") {
    return (
      <div
        className="mx-auto flex w-full max-w-md flex-col gap-4 p-8 text-center"
        data-testid="hydration-error"
      >
        {/* Explicit -0.015em, like every other R1-owned heading. The global
            h1–h6 rule already resolves to the same v2 value, so this states the
            component contract rather than correcting a default — which matters
            on a recovery state rare enough that nothing else would notice a
            drift. */}
        <h2
          data-testid="hydration-error-heading"
          className="font-heading text-h3 font-semibold tracking-[-0.015em]"
        >
          Stored data could not be loaded
        </h2>
        <p className="text-body text-ink2">
          Your saved schedule appears to be corrupted. You can reset to a new schedule to continue.
        </p>
        <Button variant="destructive" onClick={() => setResetOpen(true)}>
          Reset to new schedule
        </Button>
        <ConfirmDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          title="Reset Data"
          description="This will discard the corrupted stored data and start a new schedule."
          confirmLabel="Reset Data"
          variant="destructive"
          onConfirm={async () => {
            const outcome = await reset();
            if (outcome.status !== "reset") {
              // Still blocked, and said so plainly. The recovery surface is still
              // rendered (hydration is still `recoverable-error`), so the button
              // the user just pressed is the retry.
              toast.error(NEW_SCHEDULE_FAILED_MESSAGE);
              return;
            }
            toast.success("New schedule created");
          }}
        />
      </div>
    );
  }

  // The ownership banner sits INSIDE the gate, above the app, so a read-only tab
  // still renders the whole application (inspection stays available) with the one
  // surface that explains why nothing can be changed.
  return (
    <>
      <OwnershipBanner />
      {children}
    </>
  );
}
