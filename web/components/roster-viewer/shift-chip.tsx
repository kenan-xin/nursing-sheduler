"use client";

// The one roster chip builder (F4).
//
// DESIGN.md §5 "Roster grid" is authoritative: one builder, one box — 34×28,
// `--r-chip`, NO border. Worked shifts take their palette `fill`/`ink` from the
// fixed start-time ramp; leave is a neutral `--panel`/`--ink3` chip; rest is a
// bare `·` in `--ink3` at the same box size so columns never jitter. Leave must
// NOT use `--brandtint` + `--brand` border — that is the selection language.
//
// States are inset shadows, never a `1px transparent` border on every chip
// (which makes one variant a pixel larger than its neighbours).

import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import { dayStateDisplay } from "@/lib/roster";
import type { RosterDayState } from "@/lib/roster";
import type { ShiftRampEntry } from "@/lib/roster-viewer";

// The fixed chip geometry from DESIGN.md §5. Absolute px, NOT multiplied by the
// 0.9 baseline — only spacing and type ride the multiplier.
const CHIP_W = 34;
const CHIP_H = 28;

export interface ShiftChipProps {
  day: RosterDayState;
  /** The ramp entry for this shift, from `assignShiftRamp`. Null for leave/rest. */
  ramp: ShiftRampEntry | null;
}

/**
 * One roster chip: a 34×28 box, borderless, at `--r-chip` radius. Worked shifts
 * take their ramp `fill`/`ink`; leave is neutral `--panel`/`--ink3`; rest is a
 * bare dot at the same box size.
 *
 * The colours for worked shifts are the LITERAL ramp hexes (inline styles) —
 * DESIGN.md §2 states they are data marks, not theme tokens, and do not change
 * in dark mode. Leave and rest use semantic Tailwind tokens so they re-tint per
 * theme.
 */
export function ShiftChip({ day, ramp }: ShiftChipProps) {
  const style: React.CSSProperties = {
    minWidth: CHIP_W,
    height: CHIP_H,
  };

  if (day.kind === "off") {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center font-mono text-meta font-medium text-ink3",
        )}
        style={style}
        aria-label="Off"
      >
        ·
      </span>
    );
  }

  if (day.kind === "leave") {
    // Neutral leave: `--panel`/`--ink3`, no brand tint, no border (DESIGN.md §5).
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-chip bg-panel font-mono text-meta font-bold text-ink3",
        )}
        style={style}
        aria-label="Leave"
      >
        LV
      </span>
    );
  }

  // Worked shift: the literal ramp fill/ink.
  const entry = ramp ?? SHIFT_RAMP_FALLBACK;
  return (
    <span
      // A stable hook for the browser gate that MEASURES the 34×28 box. jsdom can
      // only read back the inline style it was given; the real geometry claim
      // needs a layout engine and something to point it at.
      data-shift-chip="worked"
      className="inline-flex items-center justify-center rounded-chip font-mono text-meta font-bold"
      style={{ ...style, backgroundColor: entry.fill, color: entry.ink }}
      aria-label={String(day.shiftId)}
    >
      {dayStateDisplay(day)}
    </span>
  );
}

/**
 * The dark overflow entry is the fallback for a shift whose ramp position could
 * not be resolved. In practice `assignShiftRamp` covers every shift id, but the
 * fallback keeps the chip total even if a caller forgets to pass the ramp.
 */
const SHIFT_RAMP_FALLBACK: ShiftRampEntry = {
  fill: "#2b2733",
  ink: "#ece6f2",
  bar: "#5c5468",
};

/** Re-export so callers can build a ramp-keyed lookup from the context. */
export { typedKeyForShiftId };

function typedKeyForShiftId(id: unknown): string {
  return typedIdKey(id as string | number);
}
