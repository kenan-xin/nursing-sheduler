"use client";

// Hydration gate + continuity (T08). On client mount this runs the T04
// hydration lifecycle (hydrateScenarioStore), registers the pagehide flush so
// pending writes survive a tab-close, and drives the undo/redo shortcuts. Until
// the store reports `ready` (or `recoverable-error`) the shell shows a skeleton
// so the user never sees the empty default before the persisted record loads
// (tech-plan §4 hydration protocol).
//
// `recoverable-error` (corrupt IndexedDB record) surfaces a reset affordance via
// resetToNewScenario — the same T04 recovery path the New button uses.

import { useEffect, useState } from "react";
import {
  useScenarioStore,
  useHotStore,
  hydrateScenarioStore,
  registerPagehideFlush,
  resetToNewScenario,
} from "@/lib/store";
import { SkeletonCard } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "./confirm-dialog";
import { useUndoRedoShortcuts } from "./undo-redo-controls";
import { usePersistenceStatusController } from "./persistence-status";
import { useSyncModePersistence } from "@/lib/mode/use-mode";
import { useRouteValidityGate } from "./use-route-validity-gate";
import { toast } from "sonner";

export function HydrationGate({ children }: { children: React.ReactNode }) {
  const scenario = useScenarioStore;
  const hot = useHotStore;
  const status = useHotStore((s) => s.hydrationStatus);
  const [resetOpen, setResetOpen] = useState(false);

  // One-shot: hydrate, register pagehide flush, persist mode.
  useEffect(() => {
    void hydrateScenarioStore(scenario, hot);
    const unreg = registerPagehideFlush(scenario);
    return unreg;
  }, [scenario, hot]);

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
        <h2 className="font-heading text-h3 font-semibold">Stored data could not be loaded</h2>
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
            await resetToNewScenario(scenario, hot);
            toast.success("New schedule created");
          }}
        />
      </div>
    );
  }

  return <>{children}</>;
}
