"use client";

// Local, Requirements-only single-select control (FR-PR-21) — a radio-group over
// shift-type groups + items. TransferList (entity-editor) is multi-only, so this
// is a small, purpose-built sibling: selecting an option REPLACES the selection
// with exactly `[value]` (never toggles/accumulates), matching the historical
// `inputType="radio"` shift-type picker. Kept local to `components/requirements/`
// per the ticket — it is not a candidate for `card-editor/` since no other editor
// needs a single-select shift-type control.

import type { ShiftTypeSingleSelectOption } from "./requirements-model";

export interface ShiftTypeSingleSelectProps {
  items: ShiftTypeSingleSelectOption[];
  groups: ShiftTypeSingleSelectOption[];
  /** 0 or 1 refs — the single-select invariant; a loaded value >1 just shows no
   *  radio as checked until the user picks one. */
  selected: readonly (string | number)[];
  onSelect: (value: string | number) => void;
  name?: string;
  testId?: string;
}

function Row({
  option,
  checked,
  name,
  onSelect,
  testId,
}: {
  option: ShiftTypeSingleSelectOption;
  checked: boolean;
  name: string;
  onSelect: (value: string | number) => void;
  testId: string;
}) {
  return (
    <label
      className={`flex items-center gap-2.5 px-2 py-[7px] ${
        option.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-panel"
      }`}
      title={option.disabledReason}
    >
      <input
        type="radio"
        name={name}
        data-testid={testId}
        aria-label={option.label}
        checked={checked}
        disabled={option.disabled}
        onChange={() => {
          if (!option.disabled) onSelect(option.value);
        }}
        className="size-3.5 accent-brand"
      />
      <span className="truncate text-meta text-ink">{option.label}</span>
    </label>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1.5 pb-1.5 pt-2 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
      {children}
    </div>
  );
}

export function ShiftTypeSingleSelect({
  items,
  groups,
  selected,
  onSelect,
  name = "shift-type-requirement-shift-type",
  testId = "shift-type-single-select",
}: ShiftTypeSingleSelectProps) {
  const isChecked = (value: string | number) => selected.some((s) => Object.is(s, value));

  if (items.length === 0 && groups.length === 0) {
    return (
      <p className="text-meta italic text-ink3" data-testid={`${testId}-empty`}>
        No shift types available. Please set up shift types in the Shifts tab first.
      </p>
    );
  }

  return (
    <div
      className="flex max-h-[228px] flex-col gap-0.5 overflow-y-auto border border-line bg-surface p-1.5"
      data-testid={testId}
    >
      {groups.length > 0 && <SectionLabel>GROUPS</SectionLabel>}
      {groups.map((opt) => (
        <Row
          key={String(opt.value)}
          option={opt}
          checked={isChecked(opt.value)}
          name={name}
          onSelect={onSelect}
          testId={`${testId}-option-${opt.value}`}
        />
      ))}
      {items.length > 0 && groups.length > 0 && <SectionLabel>SHIFT TYPES</SectionLabel>}
      {items.map((opt) => (
        <Row
          key={String(opt.value)}
          option={opt}
          checked={isChecked(opt.value)}
          name={name}
          onSelect={onSelect}
          testId={`${testId}-option-${opt.value}`}
        />
      ))}
    </div>
  );
}
