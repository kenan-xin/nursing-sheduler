"use client";

// Roster edit bar (F5, reworked for G7) — the SET {person · date} bar that appears
// when a Grid cell is selected.
//
// The prototype's flat row of shift buttons is fine for a four-shift demo and
// fails at ward scale: Ward 8 authors SIXTEEN shifts, so the shipped bar put
// eighteen undifferentiated monospace values on screen at once, several of them
// one character apart (`am1` / `am1+`, `pm2` / `pm2+`). That is well past what a
// scheduler can hold, and the codes carry no hours.
//
// So OFF and Leave stay explicit quick choices — they are day-STATES, not shifts,
// and they are the two most frequent edits — and every worked shift moves behind
// one searchable chooser that lists id, hours and description, sorted by start
// time. There is deliberately no recency store, no inferred shift family and no
// recommendation: those are guesses about the ward, and this bar has no basis
// for any of them.
//
// Cancel, autosave, Undo, keyboard activation and the coarse-pointer floor are
// unchanged; this is one control swap inside the existing edit state machine,
// not a second one.

import { useMemo, useState } from "react";
import { FaXmark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import type { EditCoordinate, RosterContext, RosterDayState } from "@/lib/roster";
import { dateLabel, shiftTimeRange } from "@/lib/roster-viewer";

export interface RosterEditBarProps {
  context: RosterContext;
  selected: EditCoordinate;
  /** The cell's CURRENT day-state, so the bar can name what it is replacing. */
  current: RosterDayState | undefined;
  /** Set the selected cell to this day-state. */
  onSetCell: (coordinate: EditCoordinate, day: RosterDayState) => void;
  /** Clear the selection without editing. */
  onCancel: () => void;
}

/** One chooser entry. `{value,label}` is the shape Base UI reads automatically. */
interface ShiftOption {
  /** The typed-id key — unique even when a numeric and string id look alike. */
  value: string;
  /** The authored id, exactly as the scenario wrote it. */
  id: string;
  label: string;
  shiftIdx: number;
  description: string | null;
}

export function RosterEditBar({
  context,
  selected,
  current,
  onSetCell,
  onCancel,
}: RosterEditBarProps) {
  // Base UI hides everything outside the picker's input from assistive tech while
  // its popup is open — `aria-hidden` lands on this bar's own OFF / LV and Cancel
  // controls (nursing-sheduler-w0e.13). But the popup is NOT modal (`modal` is the
  // Combobox default, false), and Base UI leaves focus untrapped, so those controls
  // stay in sequential focus navigation: Tab lands on content a screen reader user
  // cannot perceive. That is axe `aria-hidden-focus`.
  //
  // They are taken out of the tab order for that window. NOT `inert`: this popup is
  // non-modal, and `inert` would also kill the pointer interaction the non-modal
  // contract keeps — upstream says so in its own triage of this exact defect
  // (mui/base-ui#5528, "[combobox] Non-modal popup aria-hides outside content but
  // leaves it tabbable"), and the mechanism it proposes there is exactly this one:
  // hide from AT, remove from sequential focus navigation, keep the pointer. Escape
  // (or picking a shift) closes the popup and the controls return.
  const [pickerOpen, setPickerOpen] = useState(false);
  /** `-1` only while the popup holds the interaction; the default tab stop otherwise. */
  const hiddenTabIndex = pickerOpen ? -1 : 0;

  const person = context.people[selected.personIdx];
  const day = context.calendar[selected.dateIdx];
  const personLabel = person ? String(person.id) : "—";
  const dateText = day ? `${dateLabel(context.calendar, selected.dateIdx)} ${day.weekday}` : "—";

  // Sorted by start time, then id — the order a scheduler thinks in. A shift with
  // no authored start time sorts last rather than being dropped or guessed at.
  const options = useMemo<ShiftOption[]>(() => {
    return context.shiftTypes
      .map((shift, shiftIdx) => {
        const time = shiftTimeRange(shift);
        return {
          value: typedIdKey(shift.id),
          id: String(shift.id),
          label: time === null ? String(shift.id) : `${String(shift.id)}  ${time}`,
          shiftIdx,
          description: shift.description ?? null,
          sortKey: `${shift.startTime ?? "~~~~~"}|${String(shift.id)}`,
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey: _sortKey, ...option }) => option);
  }, [context.shiftTypes]);

  const currentLabel =
    current === undefined
      ? "—"
      : current.kind === "off"
        ? "Off"
        : current.kind === "leave"
          ? "Leave"
          : String(current.shiftId);

  return (
    <div
      data-testid="roster-edit-bar"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border border-brand bg-brandtint px-3 py-2",
      )}
    >
      <span className="font-ui text-label font-semibold uppercase tracking-[0.03em] text-brandink">
        Set {personLabel} · {dateText}
      </span>
      <span
        className="font-mono text-label font-medium text-ink2"
        data-testid="roster-edit-current"
      >
        now {currentLabel}
      </span>

      <div className="flex flex-wrap gap-1.5">
        <EditOption
          label="OFF"
          tabIndex={hiddenTabIndex}
          onClick={() => onSetCell(selected, { kind: "off" })}
        />
        <EditOption
          label="LV"
          tabIndex={hiddenTabIndex}
          onClick={() => onSetCell(selected, { kind: "leave" })}
        />
      </div>

      <div className="min-w-[220px] flex-1">
        <Combobox
          items={options}
          value={null}
          open={pickerOpen}
          onOpenChange={(open) => setPickerOpen(open)}
          itemToStringLabel={(option: ShiftOption) => option.label}
          onValueChange={(option: ShiftOption | null) => {
            if (option === null) return;
            const shift = context.shiftTypes[option.shiftIdx];
            if (shift === undefined) return;
            onSetCell(selected, { kind: "shift", shiftId: shift.id });
          }}
        >
          <ComboboxInput
            data-testid="roster-shift-picker"
            placeholder="Search shifts by id or time…"
            aria-label={`Set a shift for ${personLabel} on ${dateText}`}
          />
          <ComboboxContent>
            <ComboboxEmpty>No shift matches that search.</ComboboxEmpty>
            <ComboboxList>
              {(option: ShiftOption) => (
                <ComboboxItem
                  key={option.value}
                  value={option}
                  data-testid={`roster-shift-option-${option.id}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-mono font-bold text-ink">{option.label}</span>
                    {option.description !== null ? (
                      <span className="block truncate text-label text-ink3">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        tabIndex={hiddenTabIndex}
        onClick={onCancel}
        data-testid="roster-edit-bar-cancel"
      >
        <FaXmark className="size-3.5" aria-hidden /> Cancel
      </Button>
      {/* Audit C-08: a hand edit lives only in this roster. It is not leave or a
          request, so the solver never sees it. */}
      <p data-testid="roster-edit-scope" className="basis-full text-meta text-ink3">
        Roster only. The next run will not keep this.
      </p>
    </div>
  );
}

function EditOption({
  label,
  onClick,
  tabIndex,
}: {
  label: string;
  onClick: () => void;
  /** Out of the tab order while the shift picker's popup owns the interaction. */
  tabIndex: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={tabIndex}
      data-testid={`roster-edit-option-${label}`}
      aria-label={`Set ${label}`}
      className={cn(
        // DESIGN §touch/coarse-pointer rule: actual buttons grow to a minimum
        // 44px width and height. These are the primary touch path for the two
        // day-states, so they meet the floor directly (not via a pseudo hitbox).
        // Pill grammar, like every other real control in the system.
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-pill",
        "border border-line bg-surface px-4 shadow-1",
        "font-mono text-meta font-bold text-ink transition-colors duration-fast",
        "hover:bg-panel-alt active:shadow-none",
        "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
      )}
    >
      {label}
    </button>
  );
}
