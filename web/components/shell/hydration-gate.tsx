"use client";

// Hydration gate + continuity (T08, rebased onto repository authority in T03). On
// client mount this brings the authority up (`initializeScenarioAuthority`),
// registers the page-lifecycle listeners that keep this tab's ownership honest
// across BFCache/visibility/reconnect, mounts the lease heartbeat, and drives the
// undo/redo shortcuts. Until the store reports `ready` (or `recoverable-error`) the
// shell shows a skeleton so the user never sees the empty default before the
// committed scenario is read (tech-plan §4 hydration protocol).
//
// The pre-T03 gate also registered a `pagehide` flush, because `persist` wrote
// behind every `set` and a tab-close could strand a pending write. There is no
// write-behind any more — a command's own transaction is the write — so `pagehide`
// now does the opposite job: it RELEASES the lease so a peer tab need not wait out
// the expiry (`lifecycle.ts`).
//
// `recoverable-error` (an unreadable durable record) surfaces a reset affordance
// via resetToNewScenario — the same recovery path the New button uses.

import { useEffect, useState } from "react";
import {
  useHotStore,
  initializeScenarioAuthority,
  registerScenarioLifecycle,
  resetToNewScenario,
  useOwnershipController,
} from "@/lib/store";
import { OwnershipBanner } from "./ownership-banner";
import { SkeletonCard } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "./confirm-dialog";
import { useUndoRedoShortcuts } from "./undo-redo-controls";
import { usePersistenceStatusController } from "./persistence-status";
import { useSyncModePersistence } from "@/lib/mode/use-mode";
import { useRouteValidityGate } from "./use-route-validity-gate";
import { toast } from "sonner";

export function HydrationGate({ children }: { children: React.ReactNode }) {
  const hot = useHotStore;
  const status = useHotStore((s) => s.hydrationStatus);
  const [resetOpen, setResetOpen] = useState(false);

  // One-shot bring-up: migrate the legacy record, reread this tab's persisted
  // selection and lease, acquire when free, and register the page-lifecycle
  // listeners that keep this tab's authority honest across BFCache, visibility
  // restore, and reconnect.
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
            const outcome = await resetToNewScenario();
            if (!outcome.ok) {
              toast.error("Could not start a new schedule — the stored data is unchanged.");
              return;
            }
            // The gate is showing because bring-up found no usable authority, so a
            // successful reset has to re-run it before the app can be used.
            await initializeScenarioAuthority(hot);
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
