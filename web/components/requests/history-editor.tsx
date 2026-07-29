"use client";

// History slot editor (Normal mode; T11, FR-SR-18/19; prototype
// ScreenRequests.dc.html:252-272). One H-n slot for one person: pick a worked
// item, OFF, or LEAVE via `onSet`, or `onClear` to truncate history through
// this position. `options` is worked items + OFF + LEAVE only — NO groups
// (spec 04: "History may include OFF and Leave").

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import { cn } from "@/lib/utils";
import { FaXmark } from "@/components/icons";

export interface HistoryOption {
  id: string;
  label: string;
}

export interface HistoryEditorProps {
  open: boolean;
  who: string;
  positionLabel: string;
  currentValue: string | null;
  options: HistoryOption[];
  onSet: (value: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export function HistoryEditor({
  open,
  who,
  positionLabel,
  currentValue,
  options,
  onSet,
  onClear,
  onClose,
}: HistoryEditorProps) {
  // FR-PR-06: register the open history-slot draft as a losable draft (T08a).
  useLosableDraft("requests-history-editor", open, "Requests history editor");

  return (
    // Escape, the backdrop, X and Done all land on `onClose` and mutate nothing:
    // the option and Clear callbacks are the parent's, fire immediately on click,
    // and the parent closes this editor itself after each.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-testid="history-editor"
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-line2 px-4.5 py-4">
          <div>
            <DialogTitle>Edit history</DialogTitle>
            <DialogDescription className="mt-0.5 text-ink3">
              {who} · {positionLabel}
            </DialogDescription>
          </div>
          {/* No explicit `onClick={onClose}`: the Base UI Close part already
              emits one close event, so adding a handler would call `onClose`
              twice for a single press. */}
          <DialogClose
            aria-label="Close"
            data-testid="history-editor-close"
            render={<Button variant="outline" size="icon" />}
          >
            <FaXmark />
          </DialogClose>
        </div>

        <div className="p-4.5">
          <p className="mb-2.5 text-meta text-ink3">
            Set the shift worked on this pre-period day. History may include OFF and Leave.
          </p>
          <div className="flex flex-wrap gap-2" data-testid="history-editor-options">
            <button
              type="button"
              data-testid="history-editor-clear"
              onClick={onClear}
              className="h-9 border border-line bg-transparent px-3 text-meta font-semibold text-ink2 hover:bg-panel"
            >
              -- Clear --
            </button>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={currentValue === option.id}
                data-testid={`history-editor-option-${option.id}`}
                onClick={() => onSet(option.id)}
                className={cn(
                  "h-9 border px-3 text-meta font-semibold",
                  currentValue === option.id
                    ? "border-brand bg-brandtint text-brandink"
                    : "border-line bg-transparent text-ink2 hover:bg-panel",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end rounded-b-card border-t border-line2 bg-panel px-4.5 py-3.5">
          <Button variant="outline" data-testid="history-editor-done" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
