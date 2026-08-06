"use client";

// Undo/redo UX surface (T08, acceptance row 4; migrated to repository authority
// in T03). Three pieces:
//
// 1. useUndoRedo — reads availability from the session-authority projection.
// 2. UndoRedoControls — icon buttons wired to the repository undo/redo commands.
// 3. useUndoRedoShortcuts — a document-level keydown listener for Ctrl/Cmd+Z
//    (undo) and Ctrl/Cmd+Y (redo), app-wide. Modifier-gated per spec FR-ST-21:
//    Alt or Shift additionally held disables both shortcuts. Not suppressed
//    while typing (FR-ST-22).
//
// The USER-FACING behaviour is unchanged — same controls, same shortcuts, same
// disabled-at-the-ends semantics, and no new keyboard feature. What changed is
// what backs them. zundo kept its stack in this tab's process memory, so it could
// offer a reversal after a reload that no durable record could perform, and it
// could not be checked against a revision another tab had moved.
//
// Availability now comes from persisted commit facts: a reversal is offered only
// when the commit at the history cursor still carries live reversal material in
// the CURRENT session. After a reload, or once the 50-entry session bound has
// evicted a payload, the control is disabled — truthfully, rather than inviting a
// restore that would fail.

import { useEffect } from "react";
import { canMutateScenario, scenarioCommands, useAuthorityStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { FaRotateLeft, FaArrowRotateRight } from "@/components/icons";

function useUndoRedo() {
  const canUndo = useAuthorityStore((s) => s.canUndo && canMutateScenario(s));
  const canRedo = useAuthorityStore((s) => s.canRedo && canMutateScenario(s));

  return {
    canUndo,
    canRedo,
    // Fire-and-forget: the projection changes when the commit lands, and a refused
    // reversal (lost lease, evicted payload) settles availability from durable
    // truth rather than leaving the button lying.
    undo: () => void scenarioCommands.undo(),
    redo: () => void scenarioCommands.redo(),
  };
}

// Secondary bordered-surface control pair, composed from the shared Button
// recipe rather than re-authoring it: `secondary` + `icon` IS the v2 treatment
// this used to spell out by hand (L1 --surface fill, --line hairline, --sh-1,
// hover --panel-alt + --sh-2, active flattens to none, pill), and the recipe
// also owns the absolute 36px control box, the coarse-pointer 44px floor and
// the focus-visible outline. The hand-authored version had drifted to `size-9`,
// which the 0.9 spacing baseline renders as 32.4px rather than the control
// token's 36. Disabled is the shared reduced-opacity treatment (DESIGN.md §5).
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
    <Button
      variant="secondary"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      data-testid={testId}
    >
      {children}
    </Button>
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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // FR-ST-21: Alt or Shift additionally held disables both shortcuts.
      if (e.altKey || e.shiftKey) return;

      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        void scenarioCommands.undo();
      } else if (key === "y") {
        e.preventDefault();
        void scenarioCommands.redo();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
