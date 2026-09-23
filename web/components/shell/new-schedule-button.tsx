"use client";

// Start-over card (T08, acceptance row 3 / MINOR 8). The primary reset affordance
// lives in Save & Load — not the top bar — inside a "Start over" section with
// explanatory backup copy and a destructive (error-outline) treatment, matching
// the prototype (ScreenSaveLoad.dc.html:50-58). On confirm it calls the verified
// full reset, `resetToNewSchedule`: the roster/candidate/snapshot/session/marker
// and capture cleanup first, and only once that is proven, the T04 scenario reset
// (drop the persisted record, replace every scenario slice with the empty default,
// clear undo history, reset the hot store).
//
// F2 owns this file's PRESENTATION only, and is its sole visual owner before F4 —
// R1 and R7 consume it without editing it. v2 reading (ScreenSaveLoad.dc.html:50-58):
// an ordinary L1 card with a header band, and the destructive signal carried by the
// ACTION rather than by an error border drawn around the whole card. The button is
// the shared `destructive-outline` Button variant, so its error tone and its 44px
// coarse-pointer target come from the primitive instead of a local class override.
//
// G4 closure — the confirmed reset now goes through `resetToNewSchedule`, which
// runs the existing verified roster/stored-data cut BEFORE the scenario reset. So
// `New schedule` genuinely leaves the previous run behind (no surviving roster,
// candidate, capture state or session record, and therefore no stale capture
// notice on Optimize), and it fails closed: an unverified cut changes nothing and
// reports plainly instead of claiming `New schedule created`. `onResetComplete` is
// called only on a real reset.

import { useState } from "react";
import { NEW_SCHEDULE_FAILED_MESSAGE, resetToNewSchedule } from "@/lib/roster";
import { ConfirmDialog } from "./confirm-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { FaFileCirclePlus } from "@/components/icons";

export interface StartOverCardProps {
  onResetComplete?: () => void;
  /**
   * Test seam for the reset authority. Production uses the real one; a proof can
   * drive the failed-cleanup branch without breaking the browser's storage.
   */
  resetNewSchedule?: typeof resetToNewSchedule;
}

export function StartOverCard({ onResetComplete, resetNewSchedule }: StartOverCardProps) {
  const [open, setOpen] = useState(false);
  const reset = resetNewSchedule ?? resetToNewSchedule;

  const handleConfirm = async () => {
    // The verified roster/stored-data cut FIRST, then the scenario reset — and the
    // outcome is BRANCHED ON, not merely awaited. Both halves fail closed: nothing is
    // announced as done unless both succeeded, and the retry path is this same button.
    //
    // INTEGRATION (T03): the scenario half is now a repository command, so a refusal
    // arrives as a resolved outcome carrying a reason rather than as a throw.
    // `not-owner` is the one a user can act on — another tab holds the lease — so it
    // keeps its own message instead of being flattened into the generic one.
    const outcome = await reset();
    if (outcome.status !== "reset") {
      toast.error(
        outcome.scenarioReason === "not-owner"
          ? "This schedule is being edited in another tab. Take over editing, then start over."
          : NEW_SCHEDULE_FAILED_MESSAGE,
      );
      return;
    }
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
          "The saved roster and the last run's result",
        ]}
        onConfirm={handleConfirm}
      />
    </section>
  );
}
