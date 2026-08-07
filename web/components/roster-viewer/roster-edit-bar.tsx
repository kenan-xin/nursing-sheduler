"use client";

// Roster edit bar (F5) — the SET {person · date} bar that appears when a Grid cell
// is selected, offering [each worked shift, OFF, Leave] + Cancel.
//
// Interaction intent follows the ScreenSchedule prototype: tapping a cell shows a
// bar naming the nurse + date and the shift options as compact monospace buttons;
// choosing one sets the cell; Cancel (or tapping the selected cell again) clears
// the selection without an edit. Edits blend in — the bar is the only sign a cell
// is being edited; the cell itself renders identically to a solved one.
//
// The bar wraps inside the roster content area (flex-wrap) so a docked assistant
// narrowing the surface never forces page-level horizontal overflow.

import { FaXmark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterDayState } from "@/lib/roster";
import { dateLabel } from "@/lib/roster-viewer";
import type { EditCoordinate } from "@/lib/roster";

export interface RosterEditBarProps {
  context: RosterContext;
  selected: EditCoordinate;
  /** Set the selected cell to this day-state. */
  onSetCell: (coordinate: EditCoordinate, day: RosterDayState) => void;
  /** Clear the selection without editing. */
  onCancel: () => void;
}

export function RosterEditBar({ context, selected, onSetCell, onCancel }: RosterEditBarProps) {
  const person = context.people[selected.personIdx];
  const day = context.calendar[selected.dateIdx];
  const personLabel = person ? String(person.id) : "—";
  const dateText = day ? `${dateLabel(context.calendar, selected.dateIdx)} ${day.weekday}` : "—";

  return (
    <div
      data-testid="roster-edit-bar"
      className={cn("flex flex-wrap items-center gap-2 border border-brand bg-brandtint px-3 py-2")}
    >
      <span className="font-ui text-label font-semibold uppercase tracking-[0.03em] text-brandink">
        Set {personLabel} · {dateText}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {context.shiftTypes.map((shift) => {
          const day: RosterDayState = { kind: "shift", shiftId: shift.id };
          return (
            <EditOption
              key={typedIdKey(shift.id)}
              label={String(shift.id)}
              onClick={() => onSetCell(selected, day)}
            />
          );
        })}
        <EditOption label="OFF" onClick={() => onSetCell(selected, { kind: "off" })} />
        <EditOption label="LV" onClick={() => onSetCell(selected, { kind: "leave" })} />
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        onClick={onCancel}
        data-testid="roster-edit-bar-cancel"
      >
        <FaXmark className="size-3.5" aria-hidden /> Cancel
      </Button>
    </div>
  );
}

function EditOption({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`roster-edit-option-${label}`}
      aria-label={`Set ${label}`}
      className={cn(
        // DESIGN §touch/coarse-pointer rule: actual buttons grow to a minimum
        // 44px width and height. The edit options are the primary touch path for
        // setting a cell, so they meet the floor directly (not via a pseudo hitbox).
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center border border-line bg-surface px-3",
        "font-mono text-meta font-bold text-ink transition-colors",
        "hover:bg-panel-alt active:bg-panel",
      )}
    >
      {label}
    </button>
  );
}
