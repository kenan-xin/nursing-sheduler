"use client";

// Two-pane transfer selector — the design prototype's Available / Selected control
// (ScreenCards.dc.html:219-300). It is FULLY CONTROLLED by its `selected` prop and
// reports every add/remove through `onToggle`; it holds only its two local search
// queries. The owning form drives it from a local draft (Cancel discards, Save
// commits once).
//
// It is generic over the value type `V` so BOTH consumers share one implementation:
//   • the entity editor (People / Shift-Types group membership) passes `EntityId`
//     with `entityKey`/`sameEntityId` — exact typed identity where `1` and `"1"`
//     (and `-0`/`0`) never collapse (descriptor.ts);
//   • the card editors (T13 coverings, later T12) pass string refs with `String`
//     identity, plus optional `groups` sections and `disabled` options.
// A single `keyOf` (presentation key) drives React keys; `sameValue` drives logical
// membership. Groups (when present) render before items in each pane, and the
// SELECTED pane preserves the caller's selection order.

import * as React from "react";
import {
  FaMagnifyingGlass,
  FaXmark,
  FaArrowRight,
  FaAnglesRight,
  FaAnglesLeft,
  FaLayerGroup,
} from "@/components/icons";

/** One selectable option (an item or, when `isGroup`, a named group). */
export interface TransferOption<V = string> {
  value: V;
  label: string;
  /** Rendered before the label; groups default to a layer-group glyph. */
  icon?: React.ReactNode;
  /** Marks this option as a group (rendered in the GROUPS section). */
  isGroup?: boolean;
  /** An option that cannot be selected (e.g. an OFF/LEAVE-tainted shift group). */
  disabled?: boolean;
  /** Tooltip explaining why the option is disabled. */
  disabledReason?: string;
}

export interface TransferListProps<V = string> {
  /** Suffix for the component's data-testids (`transfer-list-<idPrefix>`, …). */
  idPrefix: string;
  /** Item options (non-group). */
  items: TransferOption<V>[];
  /** Optional group options, rendered before items in each pane. */
  groups?: TransferOption<V>[];
  /** The selected values, in the order to render them (SELECTED pane order). */
  selected: V[];
  /** Toggle one value in the owning form's draft (no store write happens here). */
  onToggle: (value: V) => void;
  /** Presentation key for React keys / DOM (defaults to `String`). */
  keyOf?: (value: V) => string;
  /** Logical equality for membership (defaults to `String` compare). */
  sameValue?: (a: V, b: V) => boolean;
  /** Section header for the non-group items (e.g. `NURSES`, `SHIFT TYPES`). */
  itemLabel?: string;
  /** Placeholder for the available-pane search. */
  searchPlaceholder?: string;
  /** Show the available-pane member-search box. Default `true`. */
  showSearch?: boolean;
  /** Visible title of the selected pane. */
  selectedTitle?: string;
  /** Testid fragment for the selected pane (`transfer-<selectedTestKey>-<id>`). */
  selectedTestKey?: string;
  /** Empty message for the available pane. */
  availableEmpty?: string;
  /** Empty message for the selected pane. */
  selectedEmpty?: string;
  /** aria-label for an add-row button (defaults to `Add <label>`). */
  addAria?: (label: string) => string;
  /** aria-label for a remove-row button (defaults to `Remove <label>`). */
  removeAria?: (label: string) => string;
  /** The selected-side filter appears once selection exceeds this (default 8). */
  selFilterThreshold?: number;
}

export function TransferList<V = string>({
  idPrefix,
  items,
  groups = [],
  selected,
  onToggle,
  keyOf = (v) => String(v),
  sameValue = (a, b) => String(a) === String(b),
  itemLabel,
  searchPlaceholder = "Search",
  showSearch = true,
  selectedTitle = "SELECTED",
  selectedTestKey = "selected",
  availableEmpty = "Everything is selected.",
  selectedEmpty = "Nothing selected — pick from the left.",
  addAria = (label) => `Add ${label}`,
  removeAria = (label) => `Remove ${label}`,
  selFilterThreshold = 8,
}: TransferListProps<V>) {
  const [availQ, setAvailQ] = React.useState("");
  const [selQ, setSelQ] = React.useState("");

  const allOptions = React.useMemo(
    () => [...groups.map((g) => ({ ...g, isGroup: true })), ...items],
    [groups, items],
  );
  const optionOf = (value: V) => allOptions.find((o) => sameValue(o.value, value));
  const isSelected = (value: V) => selected.some((s) => sameValue(s, value));

  const aq = availQ.trim().toLowerCase();
  const sq = selQ.trim().toLowerCase();
  const matches = (label: string, q: string) => !q || label.toLowerCase().includes(q);

  // Available = options not yet selected. Disabled options stay visible but inert.
  const availGroups = groups.filter((g) => !isSelected(g.value) && matches(g.label, aq));
  const availItems = items.filter((it) => !isSelected(it.value) && matches(it.label, aq));
  const availCount = availGroups.length + availItems.length;
  // Add-all skips disabled options (they can't be selected).
  const addable = [...availGroups, ...availItems].filter((o) => !o.disabled);

  // Selected tokens in caller order; unknown values (not among options) still show.
  const selTokens = selected
    .map((value) => {
      const opt = optionOf(value);
      return {
        value,
        label: opt?.label ?? String(value),
        icon: opt?.icon,
        isGroup: !!opt?.isGroup,
      };
    })
    .filter((tk) => matches(tk.label, sq));
  const selGroups = selTokens.filter((tk) => tk.isGroup);
  const selItems = selTokens.filter((tk) => !tk.isGroup);
  const showSelSearch = selected.length > selFilterThreshold;
  const groupSectionLabel = "GROUPS";

  return (
    <div
      className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2"
      data-testid={`transfer-list-${idPrefix}`}
    >
      {/* AVAILABLE pane */}
      <div
        className="flex flex-col border border-line bg-surface"
        data-testid={`transfer-available-${idPrefix}`}
      >
        <PaneHeader title="AVAILABLE" count={availCount} />
        {showSearch && (
          <SearchBox
            value={availQ}
            onChange={setAvailQ}
            placeholder={searchPlaceholder}
            testId={`transfer-search-${idPrefix}`}
            ariaLabel="Search available"
          />
        )}
        <div className="h-[228px] overflow-y-auto overflow-x-hidden border-t border-line2 px-1.5 pb-1.5">
          {availGroups.length > 0 && <SectionLabel>{groupSectionLabel}</SectionLabel>}
          {availGroups.map((opt) => (
            <AvailableRow
              key={keyOf(opt.value)}
              option={opt}
              aria={addAria(opt.label)}
              onAdd={() => onToggle(opt.value)}
            />
          ))}
          {availItems.length > 0 && availGroups.length > 0 && itemLabel && (
            <SectionLabel>{itemLabel}</SectionLabel>
          )}
          {availItems.map((opt) => (
            <AvailableRow
              key={keyOf(opt.value)}
              option={opt}
              aria={addAria(opt.label)}
              onAdd={() => onToggle(opt.value)}
            />
          ))}
          {availCount === 0 && (
            <p className="px-2 py-[18px] text-center text-meta italic text-faint">
              {aq ? `Nothing matches “${availQ}”` : availableEmpty}
            </p>
          )}
        </div>
        {addable.length > 0 && (
          <button
            type="button"
            data-testid={`transfer-add-all-${idPrefix}`}
            onClick={() => addable.forEach((o) => onToggle(o.value))}
            className="flex items-center gap-2 border-t border-line2 px-3 py-2 text-left text-meta font-semibold text-brandink hover:bg-panel"
          >
            <FaAnglesRight className="size-3" />{" "}
            {aq ? `Add all ${addable.length} matching` : `Add all ${addable.length}`}
          </button>
        )}
      </div>

      {/* SELECTED pane */}
      <div
        className="flex flex-col border border-brand bg-surface"
        data-testid={`transfer-${selectedTestKey}-${idPrefix}`}
      >
        <PaneHeader title={selectedTitle} count={selected.length} brand />
        {showSelSearch && (
          <SearchBox
            value={selQ}
            onChange={setSelQ}
            placeholder="Filter selected"
            testId={`transfer-sel-search-${idPrefix}`}
            ariaLabel={`Filter ${selectedTitle.toLowerCase()}`}
            bordered
          />
        )}
        <div className="h-[228px] overflow-y-auto overflow-x-hidden p-1.5">
          {selGroups.length > 0 && <SectionLabel>{groupSectionLabel}</SectionLabel>}
          {selGroups.map((tk) => (
            <SelectedRow
              key={keyOf(tk.value)}
              icon={tk.icon}
              label={tk.label}
              aria={removeAria(tk.label)}
              onRemove={() => onToggle(tk.value)}
            />
          ))}
          {selItems.length > 0 && selGroups.length > 0 && itemLabel && (
            <SectionLabel>{itemLabel}</SectionLabel>
          )}
          {selItems.map((tk) => (
            <SelectedRow
              key={keyOf(tk.value)}
              icon={tk.icon}
              label={tk.label}
              aria={removeAria(tk.label)}
              onRemove={() => onToggle(tk.value)}
            />
          ))}
          {selTokens.length === 0 && (
            <p className="px-2 py-[18px] text-center text-meta italic text-faint">
              {selected.length === 0 ? selectedEmpty : `Nothing matches “${selQ}”`}
            </p>
          )}
        </div>
        {selected.length > 0 && (
          <button
            type="button"
            data-testid={`transfer-clear-${idPrefix}`}
            onClick={() => selected.forEach((v) => onToggle(v))}
            className="flex items-center gap-2 border-t border-line2 px-3 py-2 text-left text-meta font-semibold text-ink3 hover:bg-panel"
          >
            <FaAnglesLeft className="size-3" /> Clear all
          </button>
        )}
      </div>
    </div>
  );
}

function PaneHeader({ title, count, brand }: { title: string; count: number; brand?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-2 border-b border-line2 px-3 py-2 text-label font-semibold uppercase tracking-[0.03em] ${
        brand ? "bg-brandtint text-brandink" : "bg-panel text-ink2"
      }`}
    >
      <span>{title}</span>
      <span className="font-mono text-ink3">{count}</span>
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
  testId,
  ariaLabel,
  bordered,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
  ariaLabel: string;
  bordered?: boolean;
}) {
  return (
    <div className={`relative px-2.5 py-2 ${bordered ? "border-b border-line2" : ""}`}>
      <FaMagnifyingGlass className="pointer-events-none absolute left-[19px] top-1/2 size-3 -translate-y-1/2 text-ink3" />
      <input
        data-testid={testId}
        aria-label={ariaLabel}
        className="h-[34px] w-full border border-line bg-surface px-8 text-meta text-ink"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          className="absolute right-[17px] top-1/2 -translate-y-1/2 text-ink3 hover:text-ink"
          onClick={() => onChange("")}
        >
          <FaXmark className="size-3" />
        </button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 bg-surface px-1.5 pb-1.5 pt-2 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
      {children}
    </div>
  );
}

function AvailableRow<V>({
  option,
  aria,
  onAdd,
}: {
  option: TransferOption<V>;
  aria: string;
  onAdd: () => void;
}) {
  const icon = option.icon ?? (option.isGroup ? <FaLayerGroup className="size-2.5" /> : null);
  if (option.disabled) {
    return (
      <div
        className="flex w-full cursor-not-allowed items-center justify-between gap-2 px-2 py-[7px] text-meta text-ink opacity-50"
        title={option.disabledReason}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon && <span className="flex-none text-ink3">{icon}</span>}
          <span className="truncate">{option.label}</span>
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={onAdd}
      className="flex w-full items-center justify-between gap-2 px-2 py-[7px] text-left text-meta text-ink hover:bg-panel"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon && <span className="flex-none text-ink3">{icon}</span>}
        <span className="truncate">{option.label}</span>
      </span>
      <FaArrowRight className="size-2.5 flex-none text-ink3" />
    </button>
  );
}

function SelectedRow({
  icon,
  label,
  aria,
  onRemove,
}: {
  icon?: React.ReactNode;
  label: string;
  aria: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      title="Remove"
      onClick={onRemove}
      className="flex w-full items-center justify-between gap-2 px-2 py-[7px] text-left text-meta text-ink hover:bg-panel"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon && <span className="flex-none text-brandink">{icon}</span>}
        <span className="truncate">{label}</span>
      </span>
      <FaXmark className="size-3 flex-none text-ink3" />
    </button>
  );
}
