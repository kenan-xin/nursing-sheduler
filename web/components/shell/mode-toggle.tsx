"use client";

// Guided/Advanced mode toggle (T08). A segmented control that flips the mode
// lens (web/lib/mode/**) — a non-mutating lossless view switch. Toggling here
// never touches the scenario store (acceptance row 1). The mode store is
// persisted by useSyncModePersistence in the shell layout.

import { useAppMode, useModeActions } from "@/lib/mode/use-mode";
import { cn } from "@/lib/utils";
import type { AppMode } from "@/lib/mode/mode";

const OPTIONS: { value: AppMode; label: string }[] = [
  { value: "guided", label: "Guided" },
  { value: "advanced", label: "Advanced" },
];

export function ModeToggle() {
  const mode = useAppMode();
  const { setMode } = useModeActions();

  return (
    <div
      data-testid="mode-toggle"
      role="group"
      aria-label="Editing mode"
      className="inline-flex border border-line"
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => setMode(opt.value)}
          aria-pressed={mode === opt.value}
          data-mode={opt.value}
          data-testid={`mode-toggle-${opt.value}`}
          className={cn(
            "px-3 py-1 text-meta font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand",
            mode === opt.value ? "bg-brand text-onbrand" : "bg-surface text-ink2 hover:bg-panel",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
