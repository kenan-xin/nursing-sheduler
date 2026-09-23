"use client";

// Upload modal (T17b-2; prototype ScreenSaveLoad.dc.html:116-139). The shared
// Dialog shell (not the AlertDialog used for confirms) with a drag/drop `.yaml`/`.yml`
// dropzone and a "load a sample scenario" affordance. This component only reads
// the dropped/selected file to TEXT and hands it to `onFile` (or defers to
// `onLoadSample` for the demo affordance) — it knows nothing about
// `prepareScenarioLoad`, the version gate, or the store; that wiring lives in
// `save-load-workspace.tsx` so this stays a dumb, reusable file picker.

import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FaFileArrowUp, FaXmark } from "@/components/icons";
// Not re-exported from the icon barrel (icons.tsx is owned by a concurrently
// edited ticket) — imported directly per the project's react-icons/fa6
// convention.
import { FaFlask } from "react-icons/fa6";

export interface UploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dropped/selected file's raw text. */
  onFile: (text: string) => void;
  /** "Load a sample scenario (demo)" — the parent owns the sample content. */
  onLoadSample: () => void;
}

/** FR-SL-10 / V1 — the only extensions accepted, via either the picker or a drop. */
const ACCEPTED_FILE_EXTENSIONS = [".yaml", ".yml"];

/**
 * Shared by the file-picker and drag-drop paths (`handleFile` below routes both
 * through it) so a dropped file can't bypass the `accept` attribute's guard,
 * which only constrains the native file-picker dialog.
 */
function validateFile(file: File): boolean {
  const extension = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
  if (!ACCEPTED_FILE_EXTENSIONS.includes(extension)) {
    alert(
      `Please upload a file with one of these extensions: ${ACCEPTED_FILE_EXTENSIONS.join(", ")}`,
    );
    return false;
  }
  return true;
}

async function readFileText(file: File): Promise<string> {
  return file.text();
}

export function UploadModal({ open, onOpenChange, onFile, onLoadSample }: UploadModalProps) {
  const [dragActive, setDragActive] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!validateFile(file)) return;
    const text = await readFileText(file);
    onFile(text);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="upload-modal"
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-line2 px-4.5 py-4">
          <DialogTitle>Upload scenario</DialogTitle>
          <DialogClose
            aria-label="Close"
            data-testid="upload-modal-close"
            render={<Button variant="outline" size="icon" />}
          >
            <FaXmark />
          </DialogClose>
        </div>

        {/* The visible instructions live inside the dropzone label, so the
            dialog's accessible description is a visually-hidden restatement
            rather than a second copy of the same sentence on screen. */}
        <DialogDescription className="sr-only">
          Drag a .yaml or .yml scenario file here, choose one from your computer, or load the sample
          scenario.
        </DialogDescription>

        <div className="flex flex-col gap-3.5 p-4.5">
          <label
            data-testid="upload-dropzone"
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              void handleFile(event.dataTransfer.files[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-control border-[1.5px] border-dashed bg-panel px-5 py-7 text-center transition-colors",
              dragActive ? "border-brand" : "border-line",
            )}
          >
            <FaFileArrowUp className="size-6 text-ink3" aria-hidden />
            <div className="text-meta font-semibold">
              Drag a <code className="font-mono">.yaml</code> /{" "}
              <code className="font-mono">.yml</code> file here
            </div>
            <div className="text-meta text-ink3">or click to choose a file</div>
            <input
              type="file"
              accept=".yaml,.yml"
              data-testid="upload-file-input"
              className="hidden"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>

          <div className="flex items-center gap-2.5">
            <div className="h-px flex-1 bg-line2" />
            <span className="text-meta text-ink3">or</span>
            <div className="h-px flex-1 bg-line2" />
          </div>

          <button
            type="button"
            data-testid="upload-load-sample-button"
            onClick={onLoadSample}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-control border border-line bg-transparent text-meta font-semibold outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand"
          >
            <FaFlask className="size-4" aria-hidden />
            Load a sample scenario (demo)
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
