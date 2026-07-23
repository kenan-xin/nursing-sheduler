"use client";

// The "Customise library" pin form (T14c) — faithful to
// docs/design_prototype/ScreenRules.dc.html rows 31-87: a constraint picker, a
// rule-name field (renames the source constraint's own description), a
// description field (the pin's own shortcut blurb), category chips, and a
// tick-list of the record's mapper-declared quick fields. `initial` is present
// when editing an existing pin; absent when pinning a new constraint.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FaArrowRight,
  FaCalculator,
  FaCheck,
  FaPeopleArrows,
  FaPlus,
  FaSliders,
  FaThumbtack,
  FaUserNurse,
  FaUserShield,
  FaXmark,
} from "@/components/icons";
import type { IconType } from "@/components/icons";
import type { GuidedRulePin } from "@/lib/scenario";
import type { PinnableRecord } from "./types";

const DEFAULT_CATEGORIES = [
  "Staffing",
  "Sequencing",
  "Hours",
  "Pairing",
  "Supervision",
  "Custom shortcuts",
];

// Mirrors rules-screen.tsx's CATEGORY_ICONS (minus "Structural", which isn't a
// pinnable category) — kept local rather than shared, to avoid a
// rules-screen.tsx <-> pin-form.tsx import cycle (rules-screen.tsx renders
// PinForm).
const CATEGORY_ICONS: Record<string, IconType> = {
  Staffing: FaUserNurse,
  Sequencing: FaArrowRight,
  Hours: FaCalculator,
  Pairing: FaPeopleArrows,
  Supervision: FaUserShield,
  "Custom shortcuts": FaThumbtack,
};

function categoryIcon(category: string): IconType {
  return CATEGORY_ICONS[category] ?? FaSliders;
}

export interface PinFormSubmission {
  constraintKind: PinnableRecord["kind"];
  constraintId: string;
  title: string;
  description: string;
  category: string;
  quickFields: string[];
}

export interface PinFormProps {
  records: PinnableRecord[];
  /** The pin being edited, and its current source card's title — absent when
   *  pinning a new constraint. */
  initial?: { pin: GuidedRulePin; title: string };
  onCancel: () => void;
  onSubmit: (submission: PinFormSubmission) => void;
}

export function PinForm({ records, initial, onCancel, onSubmit }: PinFormProps) {
  const initialRecord = initial
    ? records.find(
        (r) => r.kind === initial.pin.constraintKind && r.constraintId === initial.pin.constraintId,
      )
    : undefined;

  const [selectedKey, setSelectedKey] = React.useState(
    initialRecord ? `${initialRecord.kind}:${initialRecord.constraintId}` : "",
  );
  const [title, setTitle] = React.useState(initial?.title ?? "");
  const [description, setDescription] = React.useState(initial?.pin.description ?? "");
  const [category, setCategory] = React.useState(initial?.pin.category ?? "Custom shortcuts");
  const [quickFields, setQuickFields] = React.useState<string[]>(initial?.pin.quickFields ?? []);

  const selected = records.find((r) => `${r.kind}:${r.constraintId}` === selectedKey);

  // The record `<select>` is disabled in edit mode, so `selectedKey` only ever
  // changes in add mode. Track the prior `selectedKey` so the reset below fires
  // only on a genuine change — never on mount, whose StrictMode double-invoke
  // would otherwise clobber the edit-mode init `useState(initial?.pin.quickFields)`.
  const prevSelectedKeyRef = React.useRef(selectedKey);

  // Roving tabindex for the category radiogroup (WAI-ARIA APG radio pattern):
  // only the checked chip is a Tab stop; arrow keys move both the selection
  // and focus among the rest, wrapping at the ends.
  const categoryRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  function handleCategoryKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = DEFAULT_CATEGORIES.length;
    let nextIndex: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIndex = (index + 1) % count;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIndex = (index - 1 + count) % count;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = count - 1;
    if (nextIndex === undefined) return;
    e.preventDefault();
    setCategory(DEFAULT_CATEGORIES[nextIndex]);
    categoryRefs.current[nextIndex]?.focus();
  }

  React.useEffect(() => {
    // Reset only when `selectedKey` actually changed from its previous value —
    // not on mount, where it reflects `initial` and resetting would wipe the
    // edit-mode init `initial?.pin.quickFields`. The ref starts equal to the
    // mount `selectedKey`, so mount (and its StrictMode double-invoke) is a
    // no-op. Selecting a different record (add mode only — the select is
    // disabled when editing) resets the field selection to that record's own
    // set — a stale key from a previously-selected record must never carry over
    // (a different kind's fields rarely share the same key by coincidence, but
    // nothing should be assumed).
    if (prevSelectedKeyRef.current === selectedKey) return;
    prevSelectedKeyRef.current = selectedKey;
    setQuickFields([]);
  }, [selectedKey]);

  const canSave = selected !== undefined;

  return (
    <div className="mb-5 border border-brand bg-surface" data-testid="pin-form">
      <div className="border-b border-line2 bg-brandtint px-[18px] py-3.5">
        <div className="font-heading text-cardhead font-extrabold tracking-[-0.02em] text-brandink">
          {initial ? "Edit pinned rule" : "Pin a constraint to Rules"}
        </div>
      </div>
      <div className="flex flex-col gap-4 p-[18px]">
        <label className="block">
          <span className="mb-1.5 block text-label font-semibold uppercase tracking-[0.03em] text-ink2">
            Constraint to pin
          </span>
          <select
            value={selectedKey}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedKey(next);
              const record = records.find((r) => `${r.kind}:${r.constraintId}` === next);
              // Re-sync the rule name to the newly selected record's label on
              // every switch — not only when blank. Gating on `!title.trim()`
              // let a stale auto-filled label survive a picker switch, so submit
              // renamed the wrong constraint. The select is disabled in edit
              // mode, so overwriting here only affects add mode.
              if (record) setTitle(record.label);
            }}
            disabled={Boolean(initial)}
            className="h-10 w-full border border-line bg-surface px-3 text-body text-ink disabled:opacity-60"
            data-testid="pin-form-record-select"
          >
            <option value="">Choose a constraint…</option>
            {records.map((r) => (
              <option key={`${r.kind}:${r.constraintId}`} value={`${r.kind}:${r.constraintId}`}>
                {r.category} · {r.label}
              </option>
            ))}
          </select>
          {records.length === 0 && (
            <p className="mt-1.5 text-meta text-ink3">
              No constraints yet — add one in an Advanced editor first.
            </p>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-label font-semibold uppercase tracking-[0.03em] text-ink2">
            Rule name
          </span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Cap nights per nurse"
            data-testid="pin-form-title"
          />
          <p className="mt-1.5 text-meta text-ink3">
            This is the constraint's own name — editing it renames the constraint in Advanced too.
          </p>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-label font-semibold uppercase tracking-[0.03em] text-ink2">
            Description
          </span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A sentence explaining the rule"
            data-testid="pin-form-description"
          />
        </label>

        <div>
          <span
            id="pin-form-category-label"
            className="mb-2 block text-label font-semibold uppercase tracking-[0.03em] text-ink2"
          >
            Category
          </span>
          <div
            role="radiogroup"
            aria-labelledby="pin-form-category-label"
            className="flex flex-wrap gap-2"
          >
            {DEFAULT_CATEGORIES.map((c, i) => {
              const checked = category === c;
              const Icon = categoryIcon(c);
              return (
                <button
                  key={c}
                  ref={(el) => {
                    categoryRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setCategory(c)}
                  onKeyDown={(e) => handleCategoryKeyDown(e, i)}
                  data-testid={`pin-form-category-${c}`}
                  className={`inline-flex h-8 items-center gap-2 border px-3 text-meta font-semibold ${
                    checked
                      ? "border-brand bg-brand text-onbrand"
                      : "border-line bg-surface text-ink"
                  }`}
                >
                  <Icon className="size-2.5" /> {c}
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-line2 pt-4">
          <span
            id="pin-form-quickfields-label"
            className="block text-label font-semibold uppercase tracking-[0.03em] text-ink2"
          >
            Quick-edit numbers
          </span>
          <p className="mb-3 mt-1 max-w-[64ch] text-meta text-ink3">
            Pick which numbers become an inline Adjust control on the Rules list. Tick none for a
            display-only pin.
          </p>
          {selected && selected.quickFieldOptions.length > 0 && (
            <div
              role="group"
              aria-labelledby="pin-form-quickfields-label"
              className="flex flex-wrap gap-2"
            >
              {selected.quickFieldOptions.map((f) => {
                const on = quickFields.includes(f.key);
                const Icon = on ? FaCheck : FaPlus;
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={on}
                    data-testid={`pin-form-field-${f.key}`}
                    onClick={() =>
                      setQuickFields((prev) =>
                        prev.includes(f.key) ? prev.filter((k) => k !== f.key) : [...prev, f.key],
                      )
                    }
                    className={`inline-flex h-8 items-center gap-2 border px-3 text-meta font-semibold ${
                      on ? "border-brand bg-brand text-onbrand" : "border-line bg-surface text-ink"
                    }`}
                  >
                    <Icon className="size-2.5" /> {f.label}{" "}
                    <span className="opacity-70">{f.value}</span>
                  </button>
                );
              })}
            </div>
          )}
          {selected && selected.quickFieldOptions.length === 0 && (
            <div className="flex items-start gap-2 border border-line2 bg-panel px-3.5 py-3 text-meta text-ink2">
              This constraint has no adjustable numbers — it will pin as a display-only rule.
            </div>
          )}
          {!selected && (
            <div className="border border-dashed border-line2 px-3.5 py-3 text-meta text-faint">
              Choose a constraint above to see its adjustable numbers.
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2.5 border-t border-line2 px-[18px] py-3.5">
        <Button variant="outline" onClick={onCancel} data-testid="pin-form-cancel">
          <FaXmark className="size-3" /> Cancel
        </Button>
        <Button
          disabled={!canSave}
          data-testid="pin-form-submit"
          onClick={() => {
            if (!selected) return;
            onSubmit({
              constraintKind: selected.kind,
              constraintId: selected.constraintId,
              title: title.trim() || selected.label,
              description: description.trim(),
              category,
              quickFields,
            });
          }}
        >
          <FaThumbtack className="size-2.5" /> {initial ? "Save" : "Pin to Rules"}
        </Button>
      </div>
    </div>
  );
}
