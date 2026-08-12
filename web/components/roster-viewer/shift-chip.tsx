"use client";

// The one roster chip builder (F4).
//
// DESIGN.md §5 "Roster grid" is authoritative: one builder, one box — 34×28,
// `--r-chip`, NO border. Worked shifts take their palette `fill`/`ink` from
// their colour FAMILY (Morning/Evening/Night/Long day, `classifyShiftFamily`
// on the shift's own start time and duration — never its id or position);
// leave is a neutral `--panel`/`--ink3` chip; rest is a bare `·` in `--ink3` at
// the same box size so columns never jitter. Leave must NOT use `--brandtint`
// + `--brand` border — that is the selection language.
//
// States are inset shadows, never a `1px transparent` border on every chip
// (which makes one variant a pixel larger than its neighbours).

import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import { dayStateDisplay } from "@/lib/roster";
import type { RosterContextShiftType, RosterDayState } from "@/lib/roster";
import { shiftContextLabel } from "@/lib/roster-viewer";
import type { ShiftRampEntry } from "@/lib/roster-viewer";

// The fixed chip geometry from DESIGN.md §5. Absolute px, NOT multiplied by the
// 0.9 baseline — only spacing and type ride the multiplier.
//
// 34 is a MINIMUM, not a fixed width (G8). Ward 8 authors `long`, `long+`,
// `night` and `night+`, and with zero inline padding those glyphs ran edge to
// edge of the colour box: the label touched the fill boundary and, with only the
// cell's own 4px padding beyond it, read as colliding with the next column. The
// box now carries `padding-inline: 6px` with `box-sizing: border-box`, so a short
// id still measures exactly 34px (its content is far narrower than 34 − 12) while
// a long id grows by its own content plus the inset. The 4px table-cell padding
// is unchanged, so adjacent chips keep 8px of column-to-column separation.
const CHIP_W = 34;
const CHIP_H = 28;
const CHIP_PAD_X = 6;

export interface ShiftChipProps {
  day: RosterDayState;
  /** The ramp entry for this shift, from `assignShiftRamp`. Null for leave/rest. */
  ramp: ShiftRampEntry | null;
  /**
   * The full shift-type record for `day.shiftId`, so the chip's `aria-label`
   * can carry the shift's hours (DESIGN.md §5: "a specific id's exact hours
   * live on its chip and `aria-label`") even though the legend now names only
   * its colour family. Undefined for leave/rest, and defensively falls back to
   * the bare id if a caller omits it for a worked shift.
   */
  shift?: RosterContextShiftType;
}

/**
 * One roster chip: a minimum-34 × 28 box, borderless, at `--r-chip` radius.
 * Worked shifts take their ramp `fill`/`ink`; leave is neutral
 * `--panel`/`--ink3`; rest is a bare dot at the same box size.
 *
 * The colours for worked shifts are the LITERAL ramp hexes (inline styles) —
 * DESIGN.md §2 states they are data marks, not theme tokens, and do not change
 * in dark mode. Leave and rest use semantic Tailwind tokens so they re-tint per
 * theme.
 *
 * Every variant — worked, leave and rest — takes the SAME box, including the
 * inline inset. A rest dot narrower than its neighbours would let columns jitter
 * between rows, which is the whole reason the bare `·` was given the chip box in
 * the first place.
 */
export function ShiftChip({ day, ramp, shift }: ShiftChipProps) {
  const style: React.CSSProperties = {
    minWidth: CHIP_W,
    height: CHIP_H,
    // Border-box is load-bearing: without it the 6px inset would ADD to the 34px
    // minimum and every short id would render 46px wide, widening all 28 columns
    // for nothing.
    boxSizing: "border-box",
    paddingInline: CHIP_PAD_X,
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
  // The legend only names the shift's colour FAMILY now, so the chip's own
  // aria-label carries the one thing the legend no longer states: this id's
  // exact hours (DESIGN.md §5). `shiftContextLabel` is the same "id + hours"
  // accessible-name builder every other shift-naming surface in the viewer
  // uses; a missing `shift` record falls back to the bare id.
  const label = shift !== undefined ? shiftContextLabel(shift) : String(day.shiftId);
  return (
    <span
      // A stable hook for the browser gate that MEASURES the 34×28 box. jsdom can
      // only read back the inline style it was given; the real geometry claim
      // needs a layout engine and something to point it at.
      data-shift-chip="worked"
      // A stable, content-independent hook for tests that need to find a chip
      // by its EXACT authored id — `aria-label` now carries hours too, so
      // `long` and `long+` are no longer distinguishable by an aria-label
      // attribute selector alone.
      data-shift-id={String(day.shiftId)}
      className="inline-flex items-center justify-center rounded-chip font-mono text-meta font-bold"
      style={{ ...style, backgroundColor: entry.fill, color: entry.ink }}
      aria-label={label}
    >
      {dayStateDisplay(day)}
    </span>
  );
}

/**
 * The "other" family's fallback entry, for a shift whose start time could not
 * be classified. In practice `assignShiftRamp` covers every shift id, but the
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
