"use client";

// People bulk-upload dialog (.txt / .csv) — spec 03 FR-ED-29..32 / AC-ED-16..17.
//
// Extracted verbatim-in-behavior from the (now-retired) monolithic `entity-editor.tsx`
// (DR-2) so the Staff upload feature survived the retirement of that file (DR-5).
// It is People-owned copy but stays generic over the descriptor so the bespoke
// `PeopleTable` drives it through the same pure `reorderByUpload` core op — one
// produced state ⇒ one `mutateScenario`
// commit ⇒ one zundo entry, with reserved / duplicate / group-collision rejection
// and the identical-upload no-op preserved exactly.

import * as React from "react";
import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { FaFileArrowUp, FaXmark } from "@/components/icons";
import {
  reorderByUpload,
  type EntityDescriptor,
  type EditorItemBase,
} from "@/components/entity-editor/core";

type Commit = (next: ScenarioUiState) => void;
type CurrentState = () => ScenarioUiState;

export function UploadDialog<TItem extends EditorItemBase>({
  descriptor,
  commit,
  currentState,
  onClose,
}: {
  descriptor: EntityDescriptor<TItem>;
  commit: Commit;
  currentState: CurrentState;
  onClose: () => void;
}) {
  const onFile = async (file: File) => {
    const text = await file.text();
    if (text.trim() === "") {
      toast.error("No content found in the uploaded file.");
      return;
    }
    // Split on newlines; trim; drop blank lines and `#` comment lines (FR-ED-30).
    const names = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (names.length > 1000) {
      toast.error(
        `Uploaded file contains ${names.length} people, which exceeds the maximum of 1000. ` +
          `Please split the file and upload fewer names at a time.`,
      );
      return;
    }
    const result = reorderByUpload(currentState(), descriptor, names);
    if (!result.ok) {
      const message =
        result.error === "empty"
          ? "No people names found in the uploaded file."
          : result.error === "duplicate"
            ? `Duplicate person name "${result.name}" found in the uploaded list. ` +
              `Please remove duplicates.`
            : result.error === "reserved"
              ? `"${result.name}" is a reserved keyword and cannot be used as a name.`
              : `"${result.name}" is already used by an existing group.`;
      toast.error(message);
      return;
    }
    commit(result.state);
    toast.success(
      `Successfully uploaded ${names.length} people: ${result.reordered} existing people ` +
        `reordered, ${result.added} new people added, ${result.movedToEnd} existing people moved to end.`,
    );
    onClose();
  };

  return (
    // The parent mounts this component only while the dialog should be open, so
    // the shell is held open and every close route is routed back through
    // `onClose` — which unmounts it.
    <Dialog
      open
      onOpenChange={(next, eventDetails) => {
        if (next) return;
        // THE one exception in the app: People upload ignores Escape. The
        // dialog is a destructive-ish bulk reorder reached from a table row, and
        // a stray Escape while the OS file picker has just closed used to throw
        // the whole flow away. Cancelling the Base UI event (rather than merely
        // not calling `onClose`) also stops Base from running its own close
        // handling for that key. Backdrop, the close button and a successful
        // import still close; a validation error never does.
        if (eventDetails.reason === "escape-key") {
          eventDetails.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        data-testid="upload-dialog"
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-line2 px-4 py-3">
          <DialogTitle>Upload people list</DialogTitle>
          <DialogClose
            aria-label="Close"
            data-testid="upload-dialog-close"
            render={<Button size="icon" variant="outline" />}
          >
            <FaXmark />
          </DialogClose>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <DialogDescription>
            One name per line (<code className="font-mono">.txt</code> /{" "}
            <code className="font-mono">.csv</code>). Existing people are reordered to match the
            file, new names are added, and any not listed move to the end. Lines starting with{" "}
            <code className="font-mono">#</code> are skipped.
          </DialogDescription>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-control border border-dashed border-line bg-panel p-6 text-center hover:border-brand">
            <FaFileArrowUp className="size-6 text-ink3" />
            <span className="font-medium text-meta">Choose a .txt / .csv file</span>
            <input
              type="file"
              accept=".txt,.csv"
              data-testid="upload-file-input"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
