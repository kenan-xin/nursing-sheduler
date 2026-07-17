"use client";

// Undo/redo UX surface (T08, acceptance row 4). Two pieces:
//
// 1. useUndoRedo — subscribes to zundo's temporal store (pastStates /
//    futureStates) so the buttons reflect availability (disabled at the ends).
// 2. UndoRedoControls — icon buttons wired to undo()/redo().
// 3. useUndoRedoShortcuts — a document-level keydown listener for Ctrl/Cmd+Z
//    (undo) and Ctrl/Cmd+Y (redo), app-wide. Modifier-gated per spec FR-ST-21:
//    Alt or Shift additionally held disables both shortcuts. Not suppressed
//    while typing (FR-ST-22).

import { useEffect } from "react";
import { useStore } from "zustand";
import { useScenarioStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { FaRotateLeft, FaArrowRotateRight } from "@/components/icons";

// `store.temporal` is a vanilla zundo StoreApi — reading `pastStates` /
// `futureStates` off it directly is NOT reactive (zundo docs). Subscribe through
// zustand's `useStore(api, selector)` so the buttons re-render as history grows
// and shrinks. The imperative undo()/redo() go through `.getState()`.
function useUndoRedo() {
  const pastLength = useStore(useScenarioStore.temporal, (s) => s.pastStates.length);
  const futureLength = useStore(useScenarioStore.temporal, (s) => s.futureStates.length);

  const undo = () => useScenarioStore.temporal.getState().undo();
  const redo = () => useScenarioStore.temporal.getState().redo();

  return {
    canUndo: pastLength > 0,
    canRedo: futureLength > 0,
    undo,
    redo,
  };
}

// Secondary bordered-surface control pair (MINOR 7), sized to the prototype's
// 40×40 surface control (ScreenSchedule.dc.html:39-46,376). Disabled state drops
// the icon to `faint` with a not-allowed cursor rather than relying on opacity.
function UndoRedoButton({
  onClick,
  disabled,
  label,
  title,
  testId,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      data-testid={testId}
      className={cn(
        "flex size-9 items-center justify-center border bg-surface outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand [&_svg]:size-4",
        disabled
          ? "cursor-not-allowed border-line2 text-faint"
          : "border-line text-ink hover:bg-panel",
      )}
    >
      {children}
    </button>
  );
}

export function UndoRedoControls() {
  const { canUndo, canRedo, undo, redo } = useUndoRedo();

  return (
    <div className="flex items-center gap-1.5" data-testid="undo-redo-controls">
      <UndoRedoButton
        onClick={undo}
        disabled={!canUndo}
        label="Undo"
        title="Undo (Ctrl/Cmd+Z)"
        testId="undo-button"
      >
        <FaRotateLeft />
      </UndoRedoButton>
      <UndoRedoButton
        onClick={redo}
        disabled={!canRedo}
        label="Redo"
        title="Redo (Ctrl/Cmd+Y)"
        testId="redo-button"
      >
        <FaArrowRotateRight />
      </UndoRedoButton>
    </div>
  );
}

// App-wide Ctrl/Cmd-Z / Ctrl/Cmd-Y shortcuts. Per spec FR-ST-21: ignored when
// Alt or Shift is additionally held. Not suppressed inside form fields (FR-ST-22).
export function useUndoRedoShortcuts(): void {
  const scenarioStore = useScenarioStore;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // FR-ST-21: Alt or Shift additionally held disables both shortcuts.
      if (e.altKey || e.shiftKey) return;

      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        scenarioStore.temporal.getState().undo();
      } else if (key === "y") {
        e.preventDefault();
        scenarioStore.temporal.getState().redo();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [scenarioStore]);
}
