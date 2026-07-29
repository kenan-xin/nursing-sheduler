"use client";

// Start-over card (T08, acceptance row 3 / MINOR 8). The primary reset affordance
// lives in Save & Load — not the top bar — inside a "Start over" section with
// explanatory backup copy and a destructive (error-outline) treatment, matching
// the prototype (ScreenSaveLoad.dc.html:50-58). On confirm it calls
// resetToNewScenario (T04): drop the persisted record, replace every scenario
// slice with the empty default, clear undo history, and reset the hot store.
//
// F2 owns this file's PRESENTATION only, and is its sole visual owner before F4 —
// R1 and R7 consume it without editing it. v2 reading (ScreenSaveLoad.dc.html:50-58):
// an ordinary L1 card with a header band, and the destructive signal carried by the
// ACTION rather than by an error border drawn around the whole card. The button is
// the shared `destructive-outline` Button variant, so its error tone and its 44px
// coarse-pointer target come from the primitive instead of a local class override.
// Reset confirmation, the store call and `onResetComplete` are unchanged.

import { useState } from "react";
import { useScenarioStore, useHotStore, resetToNewScenario } from "@/lib/store";
import { ConfirmDialog } from "./confirm-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { FaFileCirclePlus } from "@/components/icons";

export interface StartOverCardProps {
  onResetComplete?: () => void;
}

export function StartOverCard({ onResetComplete }: StartOverCardProps) {
  const [open, setOpen] = useState(false);
  const scenario = useScenarioStore;
  const hot = useHotStore;

  const handleConfirm = async () => {
    await resetToNewScenario(scenario, hot);
    onResetComplete?.();
    toast.success("New schedule created");
  };

  return (
    <section
      data-testid="start-over-card"
      className={cn(
        "flex flex-col overflow-hidden",
        surfaceVariants({ role: "surface", geometry: "card" }),
      )}
    >
      {/* Header band — a single bottom edge, so it stays square inside the card. */}
      <div className="flex flex-col gap-1 border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-title font-semibold tracking-[-0.015em]">Start over</h2>
        <p className="max-w-[60ch] text-meta text-ink2">
          Clear your entire current schedule and begin a new, empty one. This removes everything
          saved in this browser and cannot be undone. Download a copy first if you want to keep it.
        </p>
      </div>
      <div className="px-5 py-4">
        <Button
          variant="destructive-outline"
          onClick={() => setOpen(true)}
          data-testid="new-schedule-button"
        >
          <FaFileCirclePlus aria-hidden />
          New schedule
        </Button>
      </div>
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
