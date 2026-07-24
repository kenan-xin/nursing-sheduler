"use client";

// The add/edit form for a shift succession (T12 M1 clone, spec 05 FR-PR-30..34).
// Composes the shared ScreenCards form panel with a Description field, a
// two-pane transfer selector for People (T09's TransferList), the NEW ordered
// PatternBuilder for the succession sequence, the prototype's chip+text
// DateScopeField for Dates (required — `allValue={["ALL"]}`, mirroring Counts),
// and the shared WeightField soft/hard dial (default -1).
//
// The form edits a flat draft; on a valid submit it hands the draft back to the
// editor, which builds the canonical card and persists exactly one tracked
// mutation. All validation/build/load logic lives in successions-model.

import { useEffect, useRef, useState } from "react";
import type { ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { FaCircleExclamation } from "@/components/icons";
import { CardEditorForm } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import { WeightField } from "@/components/card-editor/weight-field";
import { PatternBuilder } from "./pattern-builder";
import {
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildPatternShiftTypeOptions,
  buildPeopleTransferOptions,
  toggleInSelection,
  validateSuccessionForm,
  type SuccessionErrors,
  type SuccessionFormState,
} from "./successions-model";

interface SuccessionFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: SuccessionFormState;
  onSave: (form: SuccessionFormState) => void;
  onCancel: () => void;
}

/** The prototype's per-field shell: an uppercase label, an optional inline hint,
 *  the control, and the verbatim validation error line. */
function FieldShell({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          {label}
          {required && <span className="text-error"> *</span>}
        </span>
        {hint && <span className="text-meta italic text-ink3">{hint}</span>}
      </div>
      {children}
      {error && (
        <p className="flex items-center gap-1.5 text-meta font-semibold text-error" role="alert">
          <FaCircleExclamation className="size-3 flex-none" /> {error}
        </p>
      )}
    </div>
  );
}

export function SuccessionForm({
  state,
  mode,
  initialForm,
  onSave,
  onCancel,
}: SuccessionFormProps) {
  const [form, setForm] = useState<SuccessionFormState>(initialForm);
  const [errors, setErrors] = useState<SuccessionErrors>({});

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
  }, [initialForm]);

  const people = buildPeopleTransferOptions(state);
  const patternShiftTypes = buildPatternShiftTypeOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;

  function submit() {
    const nextErrors = validateSuccessionForm(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSave(form);
  }

  // FR-PR-05: while the form is VISIBLE, a global handler makes Enter save (even
  // with Shift/Alt/Ctrl/Meta held) and Escape cancel. IME composition is skipped
  // via `isComposing` OR the legacy `keyCode === 229`. Latest submit/cancel are
  // read through refs so the listener registers once (no stale closure, no
  // re-add per keystroke) — mirrors the Counts seed.
  const submitRef = useRef(submit);
  const cancelRef = useRef(onCancel);
  submitRef.current = submit;
  cancelRef.current = onCancel;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        submitRef.current();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <CardEditorForm
      heading={mode === "add" ? "Add new succession" : "Edit succession"}
      submitLabel={mode === "add" ? "Add" : "Update"}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <FieldShell label="Description">
        <Input
          data-testid="succession-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="e.g., Forbid Evening -> Day succession"
          className="h-10"
        />
      </FieldShell>

      <FieldShell label="People" required error={errors.person}>
        <TransferList<string | number>
          idPrefix="people"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={people.items}
          groups={people.groups}
          selected={form.person}
          onToggle={(ref) => {
            setForm((prev) => ({ ...prev, person: toggleInSelection(prev.person, ref) }));
            setErrors((prev) => (prev.person ? { ...prev, person: undefined } : prev));
          }}
          itemLabel="NURSES"
          searchPlaceholder="Search people"
          selectedTitle="PEOPLE"
          selectedTestKey="people"
          availableEmpty={noPeople ? "No people set up — add some on the Staff screen." : undefined}
          addAria={(l) => `Add ${l} to people`}
          removeAria={(l) => `Remove ${l} from people`}
        />
      </FieldShell>

      <FieldShell
        label="Shift type pattern"
        required
        hint="minimum 2 shift types required"
        error={errors.pattern}
      >
        <PatternBuilder
          items={patternShiftTypes.items}
          groups={patternShiftTypes.groups}
          value={form.pattern}
          onChange={(next) => {
            setForm((prev) => ({ ...prev, pattern: next }));
            setErrors((prev) => (prev.pattern ? { ...prev, pattern: undefined } : prev));
          }}
        />
      </FieldShell>

      <FieldShell label="Dates" required error={errors.date}>
        {noDates ? (
          <p className="border border-line bg-panel px-3.5 py-3 text-center text-meta italic text-ink3">
            No dates available. Please set up dates in the Dates screen first.
          </p>
        ) : (
          <DateScopeField
            autoScopes={autoScopes}
            dateGroups={dateGroups}
            dateItems={dateItems}
            // Dates is REQUIRED (spec 05): an empty `[]` means "applies to zero
            // dates", so the ALL chip must emit the explicit all-dates keyword
            // (which also satisfies the non-empty validation) rather than
            // clearing to `[]` (mirrors Counts' `countDates`).
            allValue={["ALL"]}
            value={form.date}
            onChange={(next) => {
              setForm((prev) => ({ ...prev, date: next }));
              setErrors((prev) => (prev.date ? { ...prev, date: undefined } : prev));
            }}
          />
        )}
      </FieldShell>

      <WeightField
        value={form.weight}
        error={errors.weight}
        help="Set positive weight to encourage successions and negative weight to discourage them."
        onChange={(next) => {
          setForm((prev) => ({ ...prev, weight: next }));
          setErrors((prev) => (prev.weight ? { ...prev, weight: undefined } : prev));
        }}
      />
    </CardEditorForm>
  );
}
