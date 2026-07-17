"use client";

// The ordered pattern builder — a NEW, editor-local control (per the ticket; kept
// out of the shared `components/card-editor/`/`components/entity-editor/` dirs)
// for the Successions "Shift Type Pattern" field (spec 05 FR-PR-32/33,
// EDGE-PR-08). Unlike every multi-select in the other card editors, a pattern is
// an ORDERED SEQUENCE, not a set: clicking a source button APPENDS its id
// (duplicates allowed, order significant — e.g. `Evening → Day`); each existing
// position exposes move-earlier / move-later / remove. Rendered per the
// prototype (ScreenCards.dc.html:166-206): a brand-tinted "PATTERN ORDER" panel
// of `→`-joined chips above the SHIFT GROUPS / SHIFT TYPES source buttons.
//
// Fully controlled (`value`/`onChange`) — no store access, no domain logic. The
// append/move/remove list math is exported as pure helpers so it is unit-testable
// without mounting React (`pattern-builder.test.ts`).

import * as React from "react";
import type { ShiftTypeRef } from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import {
  FaArrowRightLong,
  FaChevronLeft,
  FaChevronRight,
  FaLayerGroup,
  FaXmark,
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
        className="inline-flex h-[34px] cursor-not-allowed items-center gap-1.5 whitespace-nowrap border border-line2 bg-panel px-3 text-meta font-semibold text-ink opacity-50"
        title={option.disabledReason}
      >
        {group && <FaLayerGroup className="size-2.5 opacity-70" />}
        {option.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Add ${option.label} to the pattern`}
      onClick={onClick}
      className="inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap border border-line bg-surface px-3 text-meta font-semibold text-ink hover:border-brand hover:bg-brandtint"
    >
      {group && <FaLayerGroup className="size-2.5 opacity-70" />}
      {option.label}
    </button>
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
      className={`inline-flex cursor-grab items-center gap-1 border bg-surface py-1 pl-2.5 pr-1 text-meta font-semibold text-ink ${
        isDragging ? "opacity-50" : ""
      } ${isOver ? "border-brand shadow-[inset_2px_0_0_var(--color-brand)]" : "border-line"}`}
      data-testid={`pattern-chip-${index}`}
    >
      {label}
      <button
        type="button"
        aria-label="Move earlier"
        disabled={!canMoveEarlier}
        onClick={onMoveEarlier}
        className="px-1 text-ink3 hover:text-ink disabled:opacity-30 disabled:hover:text-ink3"
      >
        <FaChevronLeft className="size-2.5" />
      </button>
      <button
        type="button"
        aria-label="Move later"
        disabled={!canMoveLater}
        onClick={onMoveLater}
        className="px-1 text-ink3 hover:text-ink disabled:opacity-30 disabled:hover:text-ink3"
      >
        <FaChevronRight className="size-2.5" />
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="px-1 text-ink3 hover:text-error"
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
        <div
          className="flex flex-wrap items-center gap-1.5 border border-brand bg-brandtint p-3"
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
