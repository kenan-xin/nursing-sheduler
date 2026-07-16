"use client";

// New-schedule reset-with-confirm (T08, acceptance row 3). The New button opens
// a ConfirmDialog (destructive variant); on confirm it calls
// resetToNewScenario (T04) which drops the persisted record, replaces every
// scenario slice with the empty default, clears undo history, and resets the
// hot store. The confirm step prevents accidental data loss.

import { useState } from "react";
import { useScenarioStore, useHotStore, resetToNewScenario } from "@/lib/store";
import { ConfirmDialog } from "./confirm-dialog";
import { Button } from "@/components/ui/button";
import { FaPlus } from "@/components/icons";
import { toast } from "sonner";

export function NewScheduleButton() {
  const [open, setOpen] = useState(false);
  const scenario = useScenarioStore;
  const hot = useHotStore;

  const handleConfirm = async () => {
    await resetToNewScenario(scenario, hot);
    toast.success("New schedule created");
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="new-schedule-button"
      >
        <FaPlus />
        New
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="New Schedule"
        description="Are you sure you want to start from a new state? This will reset all your current data."
        confirmLabel="Reset Data"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={handleConfirm}
      />
    </>
  );
}
