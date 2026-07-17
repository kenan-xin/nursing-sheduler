"use client";

// Guided/Advanced mode toggle (T08). A segmented control that flips the mode
// lens (web/lib/mode/**) — a non-mutating lossless view switch. Toggling here
// never touches the scenario store (acceptance row 1). The mode store is
// persisted by useSyncModePersistence in the shell layout.
//
// Styled to the prototype SideNav mode control (SideNav.dc.html:23-27,64,76):
// a full-width bordered pair whose active segment is the ink surface with on-ink
// text. It lives inside AppSideNav (both the desktop rail and the mobile drawer).
//
// Semantics (audit m7 + cold-review Minor 1): the prototype uses
// `role="tablist"` / `role="tab"` with a selected-state attribute, so the control
// exposes tab semantics with `aria-selected`. Adopting the tab role also carries
// the WAI-ARIA tabs keyboard contract, implemented here with automatic
// activation: ArrowLeft/Right (and Up/Down) move focus AND select, Home/End jump
// to the ends, and only the selected tab is a tab stop (roving tabindex). The
// mode store behavior, segment dimensions/border/active fill, and focus ring
// are unchanged.

import { useRef } from "react";
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
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);

  // Automatic-activation tabs: select `value` and move focus onto its tab. The
  // selected tab reclaims tabIndex=0 after the re-render; programmatic .focus()
  // works regardless of the (pre-render) tabIndex.
  const activate = (value: AppMode) => {
    setMode(value);
    const idx = OPTIONS.findIndex((o) => o.value === value);
    tabsRef.current[idx]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = OPTIONS.findIndex((o) => o.value === mode);
    const last = OPTIONS.length - 1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      activate(OPTIONS[Math.min(idx + 1, last)].value);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      activate(OPTIONS[Math.max(idx - 1, 0)].value);
    } else if (e.key === "Home") {
      e.preventDefault();
      activate(OPTIONS[0].value);
    } else if (e.key === "End") {
      e.preventDefault();
      activate(OPTIONS[last].value);
    }
  };

  return (
    <div
      data-testid="mode-toggle"
      role="tablist"
      aria-label="Editing mode"
      aria-orientation="horizontal"
      className="flex w-full border border-line"
      onKeyDown={onKeyDown}
    >
      {OPTIONS.map((opt, i) => {
        const selected = mode === opt.value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              tabsRef.current[i] = el;
            }}
            type="button"
            role="tab"
            tabIndex={selected ? 0 : -1}
            onClick={() => activate(opt.value)}
            aria-selected={selected}
            data-mode={opt.value}
            data-testid={`mode-toggle-${opt.value}`}
            className={cn(
              "min-h-9 flex-1 px-2.5 py-1.5 text-meta transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
              i > 0 && "border-l border-line",
              selected
                ? "bg-ink font-bold text-on-ink"
                : "bg-transparent font-medium text-ink2 hover:bg-panel",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
