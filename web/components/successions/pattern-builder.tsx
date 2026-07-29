"use client";

// The ordered pattern builder — a NEW, editor-local control (per the ticket; kept
// out of the shared `components/card-editor/`/`components/entity-editor/` dirs)
// for the Successions "Shift Type Pattern" field (spec 05 FR-PR-32/33,
// EDGE-PR-08). Unlike every multi-select in the other card editors, a pattern is
// an ORDERED SEQUENCE, not a set: clicking a source button APPENDS its id
// (duplicates allowed, order significant — e.g. `Evening → Day`); each existing
// position exposes move-earlier / move-later / remove. Rendered per the
// prototype (ScreenCards.dc.html:166-206): a "PATTERN ORDER" panel of `→`-joined
// chips above the SHIFT GROUPS / SHIFT TYPES source buttons. The panel carries the
// shared `selected` role rather than the prototype's `--brandtint` wash, per the
// adoption deviation rule that DESIGN.md outranks prototype examples.
//
// Fully controlled (`value`/`onChange`) — no store access, no domain logic. The
// append/move/remove list math is exported as pure helpers so it is unit-testable
// without mounting React (`pattern-builder.test.ts`).

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import type { ShiftTypeRef } from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import {
  FaArrowRightLong,
  FaChevronLeft,
  FaChevronRight,
  FaLayerGroup,
  FaXmark,
  FaPlus,
  FaCircleExclamation,
} from "@/components/icons";
import type { PatternShiftTypeOptionValue } from "./successions-model";

// --- Pure list helpers (exported for `pattern-builder.test.ts`) -------------

/** Append `id` to the end of the pattern — duplicates allowed, always appends
 *  (never toggles/dedupes) since a pattern position is ordered, not a set. */
export function appendPatternEntry(
  pattern: readonly ShiftTypeRef[],
  id: ShiftTypeRef,
): ShiftTypeRef[] {
  return [...pattern, id];
}

/** Swap the entries at `a`/`b`; a no-op (fresh copy) when either index is out of
 *  range — the caller's move buttons are already disabled at the pattern's ends,
 *  so this is a defensive floor, not a reachable UI path. */
function swap(pattern: readonly ShiftTypeRef[], a: number, b: number): ShiftTypeRef[] {
  if (a < 0 || b < 0 || a >= pattern.length || b >= pattern.length) return [...pattern];
  const next = [...pattern];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** Move the entry at `index` one position earlier (toward the front). */
export function movePatternEntryEarlier(
  pattern: readonly ShiftTypeRef[],
  index: number,
): ShiftTypeRef[] {
  return swap(pattern, index, index - 1);
}

/** Move the entry at `index` one position later (toward the back). */
export function movePatternEntryLater(
  pattern: readonly ShiftTypeRef[],
  index: number,
): ShiftTypeRef[] {
  return swap(pattern, index, index + 1);
}

/** Remove the single entry at `index`. */
export function removePatternEntry(
  pattern: readonly ShiftTypeRef[],
  index: number,
): ShiftTypeRef[] {
  return pattern.filter((_, i) => i !== index);
}

/**
 * Reorder a pattern for a drag-drop, honoring the pointer-half `position`
 * (FR-PR-33): `"before"` inserts the dragged entry immediately before the
 * hovered entry, `"after"` immediately after — computed against the ORIGINAL
 * indices, then corrected for the gap left by removing the dragged entry.
 * Pure so the insertion math is unit-testable without mounting React (mirrors
 * `reorderByDrop` in `successions-model.ts`, but keyed by index since a pattern
 * allows duplicate ids and so has no stable per-entry key).
 */
export function reorderPatternByDrop(
  pattern: readonly ShiftTypeRef[],
  from: number,
  to: number,
  position: "before" | "after",
): ShiftTypeRef[] {
  if (from < 0 || to < 0 || from >= pattern.length || to >= pattern.length || from === to) {
    return [...pattern];
  }
  let insertAt = position === "before" ? to : to + 1;
  const next = [...pattern];
  const [moved] = next.splice(from, 1);
  // Removing `from` shifts every later index left by one.
  if (from < insertAt) insertAt -= 1;
  next.splice(insertAt, 0, moved);
  return next;
}

// --- Presentational component ------------------------------------------------

export interface PatternBuilderProps {
  /** Authored shift-type items + the synthetic OFF/LEAVE items (spec 05
   *  EDGE-PR-08 — Successions does not exclude either). */
  items: TransferOption<PatternShiftTypeOptionValue>[];
  /** Authored shift-type groups + the synthetic ALL group. */
  groups: TransferOption<PatternShiftTypeOptionValue>[];
  value: readonly ShiftTypeRef[];
  onChange: (next: ShiftTypeRef[]) => void;
  error?: string;
}

function labelOf(
  id: ShiftTypeRef,
  items: TransferOption<PatternShiftTypeOptionValue>[],
  groups: TransferOption<PatternShiftTypeOptionValue>[],
): string {
  const option = groups.find((o) => o.value === id) ?? items.find((o) => o.value === id);
  return option?.label ?? String(id);
}

function SourceButton({
  option,
  group,
  onClick,
}: {
  option: TransferOption<PatternShiftTypeOptionValue>;
  group?: boolean;
  onClick: () => void;
}) {
  if (option.disabled) {
    return (
      <span
        className="inline-flex h-control-sm cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-pill border border-line2 bg-panel px-3 text-meta font-semibold text-ink opacity-50"
        title={option.disabledReason}
      >
        {group && <FaLayerGroup className="size-2.5 opacity-70" />}
        {option.label}
      </span>
    );
  }
  // The `--brandtint` + `--brand` hover is retired here for the same reason as the
  // date-scope chips: DESIGN.md §6 reserves that pairing for selection, and these
  // are a palette of things you can ADD, none of which is selected. The shared
  // Button contract supplies the L1 fill, the pill, and the coarse-pointer target.
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Add ${option.label} to the pattern`}
      onClick={onClick}
    >
      {group && <FaLayerGroup className="size-2.5 opacity-70" />}
      {option.label}
      <FaPlus className="size-2.5 text-ink3" aria-hidden />
    </Button>
  );
}

function PatternChip({
  label,
  index,
  canMoveEarlier,
  canMoveLater,
  onMoveEarlier,
  onMoveLater,
  onRemove,
  isDragging,
  isOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  label: string;
  index: number;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  onRemove: () => void;
  isDragging: boolean;
  isOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: (position: "before" | "after") => void;
  onDragEnd: () => void;
}) {
  return (
    <span
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        // FR-PR-33: left half of the hovered chip ⇒ drop BEFORE it, right half ⇒
        // drop AFTER it (chips flow horizontally). Computed from the pointer X vs
        // the chip's horizontal midpoint.
        const rect = e.currentTarget.getBoundingClientRect();
        onDrop(e.clientX < rect.left + rect.width / 2 ? "before" : "after");
      }}
      onDragEnd={onDragEnd}
      // The drop candidate borrows the shared `drop-target` LANGUAGE — a dashed
      // brand edge over the hover tone — rather than the hand-authored inset rule
      // it used to carry. That arbitrary `shadow-[inset_2px_0_0_...]` was an
      // untokened elevation value, which the F4 provenance scanner rejects even
      // when the value happens to match: a copy stops tracking its source the
      // moment either side is retuned.
      className={`inline-flex cursor-grab items-center gap-1 rounded-pill border py-1 pl-2.5 pr-1 text-meta font-semibold text-ink ${
        isDragging ? "opacity-50" : ""
      } ${isOver ? "border-dashed border-brand bg-panel-alt shadow-2" : "border-line bg-surface shadow-1"}`}
      data-testid={`pattern-chip-${index}`}
      // See CardListItem: a waitable hook for the drag state the chips share.
      data-dragging={isDragging ? "true" : undefined}
    >
      {label}
      <button
        type="button"
        aria-label="Move earlier"
        disabled={!canMoveEarlier}
        onClick={onMoveEarlier}
        className="inline-flex items-center justify-center px-1 text-ink3 hover:text-ink disabled:opacity-30 disabled:hover:text-ink3 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
      >
        <FaChevronLeft className="size-2.5" />
      </button>
      <button
        type="button"
        aria-label="Move later"
        disabled={!canMoveLater}
        onClick={onMoveLater}
        className="inline-flex items-center justify-center px-1 text-ink3 hover:text-ink disabled:opacity-30 disabled:hover:text-ink3 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
      >
        <FaChevronRight className="size-2.5" />
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="inline-flex items-center justify-center px-1 text-ink3 hover:text-errorink pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
      >
        <FaXmark className="size-3" />
      </button>
    </span>
  );
}

export function PatternBuilder({ items, groups, value, onChange, error }: PatternBuilderProps) {
  // HTML5 DnD state for the primary drag reorder (FR-PR-33); the per-chip arrow
  // buttons remain the accessible supplement (mirrors the card-list DnD pattern).
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  return (
    <div className="flex flex-col gap-3" data-testid="pattern-builder">
      <p className="text-meta italic text-ink3">Click shift types to build an ordered sequence.</p>

      {value.length === 0 ? (
        <p className="text-meta italic text-ink3" data-testid="pattern-builder-empty">
          No shift types added yet — click below to build the sequence (e.g. Night → Morning).
          Minimum 2, duplicates allowed.
        </p>
      ) : (
        // The built pattern IS the selection, so it takes the shared `selected`
        // role (a `--brand` border and `--sh-2` on `--surface`) — the same treatment
        // the transfer list's SELECTED pane uses — rather than a `--brandtint`
        // wash that would compete with the chips sitting on it.
        <div
          className={cn(
            "flex flex-wrap items-center gap-1.5 p-3",
            surfaceVariants({ role: "selected", geometry: "control" }),
          )}
          data-testid="pattern-builder-order"
        >
          {value.map((id, index) => (
            <React.Fragment key={index}>
              {index > 0 && <FaArrowRightLong className="size-2.5 text-brandink" aria-hidden />}
              <PatternChip
                label={labelOf(id, items, groups)}
                index={index}
                canMoveEarlier={index > 0}
                canMoveLater={index < value.length - 1}
                onMoveEarlier={() => onChange(movePatternEntryEarlier(value, index))}
                onMoveLater={() => onChange(movePatternEntryLater(value, index))}
                onRemove={() => onChange(removePatternEntry(value, index))}
                isDragging={dragIndex === index}
                isOver={overIndex === index && dragIndex !== null && dragIndex !== index}
                onDragStart={() => setDragIndex(index)}
                onDragOver={() => setOverIndex(index)}
                onDrop={(position) => {
                  if (dragIndex !== null && dragIndex !== index) {
                    onChange(reorderPatternByDrop(value, dragIndex, index, position));
                  }
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
              />
            </React.Fragment>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            SHIFT GROUPS
          </span>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((opt) => (
              <SourceButton
                key={String(opt.value)}
                option={opt}
                group
                onClick={() => onChange(appendPatternEntry(value, opt.value as ShiftTypeRef))}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
          SHIFT TYPES
        </span>
        <div className="flex flex-wrap gap-1.5">
          {items.map((opt) => (
            <SourceButton
              key={String(opt.value)}
              option={opt}
              onClick={() => onChange(appendPatternEntry(value, opt.value as ShiftTypeRef))}
            />
          ))}
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-meta font-semibold text-error" role="alert">
          <FaCircleExclamation className="size-3 flex-none" /> {error}
        </p>
      )}
    </div>
  );
}
