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
import { Button } from "@/components/ui/button";
import { FaRotateLeft, FaArrowRotateRight } from "@/components/icons";

// `store.temporal` is a vanilla zundo StoreApi — reading `pastStates` /
// `futureStates` off it directly is NOT reactive (zundo docs). Subscribe through
// zustand's `useStore(api, selector)` so the buttons re-render as history grows
// and shrinks. The imperative undo()/redo() go through `.getState()`.
export function useUndoRedo() {
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

export function UndoRedoControls() {
  const { canUndo, canRedo, undo, redo } = useUndoRedo();

  // On the dark chrome top bar the shared `ghost` variant's `text-ink` is
  // invisible (1:1). `on-ink` is the foreground token for the ink/chrome bar
  // (light in both themes; see nursing-sheduler-2dn).
  const chromeGhost = "text-on-ink hover:bg-on-ink/10";

  return (
    <div className="flex items-center gap-1" data-testid="undo-redo-controls">
      <Button
        variant="ghost"
        size="icon"
        onClick={undo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo (Ctrl/Cmd+Z)"
        data-testid="undo-button"
        className={chromeGhost}
      >
        <FaRotateLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={redo}
        disabled={!canRedo}
        aria-label="Redo"
        title="Redo (Ctrl/Cmd+Y)"
        data-testid="redo-button"
        className={chromeGhost}
      >
        <FaArrowRotateRight />
      </Button>
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
