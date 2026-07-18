"use client";

// Upload modal (T17b-2; prototype ScreenSaveLoad.dc.html:116-139). A base-ui
// Dialog (not the AlertDialog used for confirms) with a drag/drop `.yaml`/`.yml`
// dropzone and a "load a sample scenario" affordance. This component only reads
// the dropped/selected file to TEXT and hands it to `onFile` (or defers to
// `onLoadSample` for the demo affordance) — it knows nothing about
// `prepareScenarioLoad`, the version gate, or the store; that wiring lives in
// `load-controls.tsx` so this stays a dumb, reusable file picker.

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 animate-fade" />
        <Dialog.Popup
          data-testid="upload-modal"
          className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 border border-line bg-surface shadow-dialog animate-fade"
        >
          <div className="flex items-center justify-between border-b border-line2 px-[18px] py-4">
            <Dialog.Title className="font-heading text-cardhead font-extrabold tracking-tight">
              Upload scenario
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              data-testid="upload-modal-close"
              className="flex size-8 items-center justify-center border border-line text-ink2 outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand"
            >
              <FaXmark className="size-4" />
            </Dialog.Close>
          </div>

          <div className="flex flex-col gap-3.5 p-[18px]">
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
                "flex cursor-pointer flex-col items-center justify-center gap-2.5 border-[1.5px] border-dashed bg-panel px-5 py-7 text-center transition-colors",
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
              className="flex h-10 w-full items-center justify-center gap-2 border border-line bg-transparent text-meta font-semibold outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand"
            >
              <FaFlask className="size-4" aria-hidden />
              Load a sample scenario (demo)
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
