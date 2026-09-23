"use client";

// Requests/History CSV upload modal (T11, FR-SR-34-37; prototype
// ScreenRequests.dc.html:274-293). Reads the chosen file to TEXT and hands it to
// `onFileText` — it knows nothing about row/column validation, the weight
// draft, or the store; that parsing (`requests-csv.ts`) and wiring live in the
// container. No sample-data affordance (unlike `upload-modal.tsx`) — the ticket
// does not call for one here.

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FaFileArrowUp, FaXmark } from "@/components/icons";

export interface RequestsCsvModalProps {
  open: boolean;
  kind: "requests" | "history" | null;
  onFileText: (text: string) => void;
  onClose: () => void;
}

const COPY: Record<
  "requests" | "history",
  { title: string; description: string; example: string }
> = {
  requests: {
    title: "Requests CSV",
    description:
      "One row per person, one column per date item (person id first). Each cell holds a shift-type or shift-group id, or is left blank to leave that person/date unchanged.",
    example: "person,2026-01-01,2026-01-02,2026-01-03\nkevin,AM,,PM\naisha,,N,",
  },
  history: {
    title: "History CSV",
    description:
      "Exactly 3 columns, no header: name, shift-type id, repetition count. An empty shift-type or a repetition count of 0 clears that person's history.",
    example: "kevin,OFF,2\naisha,AM,1\nnurul,,0",
  },
};

export function RequestsCsvModal({ open, kind, onFileText, onClose }: RequestsCsvModalProps) {
  const copy = COPY[kind ?? "requests"];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-testid="requests-csv-modal"
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-line2 px-4.5 py-4">
          <DialogTitle>{copy.title}</DialogTitle>
          {/* The Base UI Close part already emits the single close event; an
              extra `onClick={onClose}` would call the parent twice per press. */}
          <DialogClose
            aria-label="Close"
            data-testid="requests-csv-modal-close"
            render={<Button variant="outline" size="icon" />}
          >
            <FaXmark />
          </DialogClose>
        </div>

        <div className="p-4.5">
          <DialogDescription className="mb-2.5">{copy.description}</DialogDescription>
          <pre className="mb-3.5 overflow-auto rounded-control border border-line2 bg-bg px-3 py-2.5 font-mono text-meta text-ink2">
            {copy.example}
          </pre>
          <label
            data-testid="requests-csv-dropzone"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-control border-[1.5px] border-dashed border-line bg-panel px-5.5 py-5.5 text-center hover:border-brand"
          >
            <FaFileArrowUp className="size-5.5 text-ink3" aria-hidden />
            <div className="text-meta font-semibold">Choose a .csv / .txt file</div>
            {/* The input is reset before the read so the same file can be picked
                again, and `onFileText` is called exactly once per selection. */}
            <input
              type="file"
              accept=".csv,.txt"
              data-testid="requests-csv-file-input"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void file.text().then(onFileText);
              }}
            />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
