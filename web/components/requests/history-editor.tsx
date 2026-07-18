"use client";

// History slot editor (Normal mode; T11, FR-SR-18/19; prototype
// ScreenRequests.dc.html:252-272). One H-n slot for one person: pick a worked
// item, OFF, or LEAVE via `onSet`, or `onClear` to truncate history through
// this position. `options` is worked items + OFF + LEAVE only — NO groups
// (spec 04: "History may include OFF and Leave").

import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
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
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 animate-fade" />
        <Dialog.Popup
          data-testid="history-editor"
          className="fixed left-1/2 top-1/2 z-50 w-[380px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 border border-line bg-surface shadow-dialog animate-fade"
        >
          <div className="flex items-center justify-between border-b border-line2 px-[18px] py-4">
            <div>
              <Dialog.Title className="font-heading text-cardhead font-extrabold tracking-tight">
                Edit history
              </Dialog.Title>
              <div className="mt-0.5 text-meta text-ink3">
                {who} · {positionLabel}
              </div>
            </div>
            <Dialog.Close
              aria-label="Close"
              data-testid="history-editor-close"
              onClick={onClose}
              className="flex size-8 items-center justify-center border border-line text-ink2 outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand"
            >
              <FaXmark className="size-4" />
            </Dialog.Close>
          </div>

          <div className="p-[18px]">
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

          <div className="flex justify-end border-t border-line2 px-[18px] py-3.5">
            <Button variant="outline" data-testid="history-editor-done" onClick={onClose}>
              Done
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
