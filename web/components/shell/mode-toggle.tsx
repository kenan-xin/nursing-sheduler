"use client";

// Guided/Advanced mode toggle (T08). A segmented control that flips the mode
// lens (web/lib/mode/**) — a non-mutating lossless view switch. Toggling here
// never touches the scenario store (acceptance row 1). The mode store is
// persisted by useSyncModePersistence in the shell layout.
//
// Styled to the prototype SideNav mode control (SideNav.dc.html:23-27,64,76,81):
// a panel-fill pill track whose active segment lifts to the surface tone with
// --sh-1 and brandink text, and whose inactive segment is transparent ink2. It
// lives inside AppSideNav (both the desktop rail and the mobile drawer).
//
// Semantics (audit m7 + cold-review Minor 1): the prototype uses
// `role="tablist"` / `role="tab"` with a selected-state attribute, so the control
// exposes tab semantics with `aria-selected`. Adopting the tab role also carries
// the WAI-ARIA tabs keyboard contract, implemented here with automatic
// activation: ArrowLeft/Right (and Up/Down) move focus AND select, Home/End jump
// to the ends, and only the selected tab is a tab stop (roving tabindex). The
// mode store behavior, segment dimensions, and focus ring are unchanged.

import { useRef } from "react";
import { useAppMode } from "@/lib/mode/use-mode";
import { useModeTransition } from "./use-mode-transition";
import { cn } from "@/lib/utils";
import type { AppMode } from "@/lib/mode/mode";

const OPTIONS: { value: AppMode; label: string }[] = [
  { value: "guided", label: "Guided" },
  { value: "advanced", label: "Advanced" },
];

export function ModeToggle() {
  const mode = useAppMode();
  const { requestModeChange } = useModeTransition();
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);

  // Automatic-activation tabs: select `value` and move focus onto its tab. The
  // selected tab reclaims tabIndex=0 after the re-render; programmatic .focus()
  // works regardless of the (pre-render) tabIndex. Both click and keyboard
  // activation route through the same mode-transition transaction (T08c) —
  // never a bare `setMode`. Focus moves ONLY from `onCommitted` (T08f P2):
  // moving it on the mere request would strand it on the not-yet-selected tab
  // if the transition is later canceled.
  //
  // A pointer click, unlike keyboard activation, moves DOM focus to the
  // clicked (target) button BEFORE `onClick` runs — a browser default, not
  // something this component controls. If the transition then stages (an open
  // draft on a route the target mode can't keep) and the user cancels, focus
  // would be left on that now-unselected target tab with `tabIndex=-1` (T08d
  // repair P2). Capturing the currently-selected tab's index before the
  // request and restoring focus to it via `onCancelled` fixes that without
  // touching the committed-focus path above: on an immediate commit
  // `onCancelled` never fires, and for keyboard activation focus never left
  // the current tab in the first place, so restoring it there is a no-op.
  const activate = (value: AppMode) => {
    const idx = OPTIONS.findIndex((o) => o.value === value);
    const previousIdx = OPTIONS.findIndex((o) => o.value === mode);
    requestModeChange(
      value,
      () => tabsRef.current[idx]?.focus(),
      () => tabsRef.current[previousIdx]?.focus(),
    );
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
      // v2 pill track (SideNav.dc.html:25): a panel-fill pill with a 4px inset,
      // not the v1 bordered rectangle. Active segment lifts to the surface tone
      // with --sh-1 and brandink text; inactive is transparent ink2.
      className="flex w-full gap-1 rounded-pill bg-panel p-1"
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
              // `min-h-control` (the absolute 36px token), not `min-h-9` — the
              // 0.9 spacing baseline renders `9` as 32.4px, below the control
              // floor. Coarse pointers grow the real segment to 44px.
              "min-h-control flex-1 rounded-pill px-2.5 py-1.5 text-meta transition-[background-color,box-shadow,color] outline-none pointer-coarse:min-h-touch focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
              selected
                ? "bg-surface font-bold text-brandink shadow-1"
                : "font-medium text-ink2 hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
