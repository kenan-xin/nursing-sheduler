"use client";

// Start-over card (T08, acceptance row 3 / MINOR 8). The primary reset affordance
// lives in Save & Load — not the top bar — inside a "Start over" section with
// explanatory backup copy and a destructive (error-outline) treatment, matching
// the prototype (ScreenSaveLoad.dc.html:50-58). On confirm it calls
// resetToNewScenario (T04): drop the persisted record, replace every scenario
// slice with the empty default, clear undo history, and reset the hot store.

import { useState } from "react";
import { useScenarioStore, useHotStore, resetToNewScenario } from "@/lib/store";
import { ConfirmDialog } from "./confirm-dialog";
import { toast } from "sonner";

export function StartOverCard() {
  const [open, setOpen] = useState(false);
  const scenario = useScenarioStore;
  const hot = useHotStore;

  const handleConfirm = async () => {
    await resetToNewScenario(scenario, hot);
    toast.success("New schedule created");
  };

  return (
    <section
      data-testid="start-over-card"
      className="flex flex-col items-start gap-2 border border-error bg-surface p-4"
    >
      <h2 className="font-heading text-title font-semibold tracking-tight text-error">
        Start over
      </h2>
      <p className="max-w-[60ch] text-meta text-ink2">
        Clear your entire current schedule and begin a new, empty one. This removes everything saved
        in this browser and cannot be undone.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="new-schedule-button"
        className="mt-1 inline-flex h-9 items-center gap-2 border border-error bg-surface px-4 text-meta font-semibold text-error outline-none transition-colors hover:bg-errortint focus-visible:ring-2 focus-visible:ring-error"
      >
        New schedule
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Start over?"
        description="This clears your entire current schedule and starts a new, empty one. It cannot be undone."
        confirmLabel="Start over"
        cancelLabel="Cancel"
        variant="destructive"
        consequences={[
          "All people, shift types and dates",
          "Every rule and request",
          "Your export layout",
        ]}
        onConfirm={handleConfirm}
      />
    </section>
  );
}
