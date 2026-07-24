"use client";

// People bulk-upload dialog (.txt / .csv) — spec 03 FR-ED-29..32 / AC-ED-16..17.
//
// Extracted verbatim-in-behavior from the monolithic `entity-editor.tsx` (DR-2)
// so the Staff upload feature survives the later retirement of that file (DR-5).
// It is People-owned copy but stays generic over the descriptor so both the
// bespoke `PeopleTable` and (transitionally) `EntityEditor` drive it through the
// same pure `reorderByUpload` core op — one produced state ⇒ one `mutateScenario`
// commit ⇒ one zundo entry, with reserved / duplicate / group-collision rejection
// and the identical-upload no-op preserved exactly.

import * as React from "react";
import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import { Button } from "@/components/ui/button";
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
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(8,10,14,0.5)]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Upload people list"
        data-testid="upload-dialog"
        className="w-[460px] max-w-[92vw] border border-line bg-surface shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line2 px-4 py-3">
          <h3 className="font-heading text-cardhead font-semibold">Upload people list</h3>
          <Button size="icon" variant="outline" aria-label="Close" onClick={onClose}>
            <FaXmark />
          </Button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-meta text-ink2">
            One name per line (<code className="font-mono">.txt</code> /{" "}
            <code className="font-mono">.csv</code>). Existing people are reordered to match the
            file, new names are added, and any not listed move to the end. Lines starting with{" "}
            <code className="font-mono">#</code> are skipped.
          </p>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-line bg-panel p-6 text-center hover:border-brand">
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
      </div>
    </div>
  );
}
