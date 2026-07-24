"use client";

// The add/edit form for a shift affinity (T12 M1 clone, spec 05 FR-PR-60..62).
// Composes the shared ScreenCards form panel with a Description field, three
// two-pane transfer selectors — People 1, People 2 (both over the same people
// domain), and Shift Types (extending T09's TransferList) — the prototype's
// chip+text DateScopeField for Dates (REQUIRED here, unlike Coverings), and the
// shared WeightField soft/hard dial (default +1, no sign restriction).
//
// The form edits a flat draft; on a valid submit it hands the draft back to the
// editor, which builds the canonical card and persists exactly one tracked
// mutation. All validation/build/load logic lives in affinities-model.

import { useEffect, useRef, useState } from "react";
import type { ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { FaCircleExclamation } from "@/components/icons";
import { CardEditorForm } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import { WeightField } from "@/components/card-editor/weight-field";
import {
  buildAffinityShiftTypeTransferOptions,
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildPeopleTransferOptions,
  toggleInSelection,
  validateAffinityForm,
  type AffinityErrors,
  type AffinityFormState,
} from "./affinities-model";

interface AffinityFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: AffinityFormState;
  onSave: (form: AffinityFormState) => void;
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

export function AffinityForm({ state, mode, initialForm, onSave, onCancel }: AffinityFormProps) {
  const [form, setForm] = useState<AffinityFormState>(initialForm);
  const [errors, setErrors] = useState<AffinityErrors>({});

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
  }, [initialForm]);

  const people = buildPeopleTransferOptions(state);
  const shiftTypes = buildAffinityShiftTypeTransferOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noShifts = shiftTypes.items.length === 0 && shiftTypes.groups.length === 0;
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;

  function submit() {
    const nextErrors = validateAffinityForm(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSave(form);
  }

  // FR-PR-05: while the form is VISIBLE, a global handler makes Enter save (even
  // with Shift/Alt/Ctrl/Meta held) and Escape cancel — Affinities is one of the
  // first four editors, which save on Enter regardless of modifiers (unlike the
  // covering editor's stricter no-modifier gate). IME composition is skipped via
  // `isComposing` OR the legacy `keyCode === 229`. Latest submit/cancel are read
  // through refs so the listener registers once (no stale closure).
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
      heading={mode === "add" ? "Add new affinity" : "Edit affinity"}
      submitLabel={mode === "add" ? "Add" : "Update"}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <FieldShell label="Description">
        <Input
          data-testid="affinity-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="e.g., Encourage newcomers and seniors to work together"
          className="h-10"
        />
      </FieldShell>

      <FieldShell label="People 1" required error={errors.people1}>
        <TransferList<string | number>
          idPrefix="people1"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={people.items}
          groups={people.groups}
          selected={form.people1}
          onToggle={(ref) => {
            setForm((prev) => ({ ...prev, people1: toggleInSelection(prev.people1, ref) }));
            setErrors((prev) => (prev.people1 ? { ...prev, people1: undefined } : prev));
          }}
          itemLabel="NURSES"
          searchPlaceholder="e.g. Chloe Ng"
          selectedTitle="PEOPLE 1"
          selectedTestKey="people1"
          availableEmpty={noPeople ? "No people set up — add some on the Staff screen." : undefined}
          addAria={(l) => `Add ${l} to people 1`}
          removeAria={(l) => `Remove ${l} from people 1`}
        />
      </FieldShell>

      <FieldShell label="People 2" required error={errors.people2}>
        <TransferList<string | number>
          idPrefix="people2"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={people.items}
          groups={people.groups}
          selected={form.people2}
          onToggle={(ref) => {
            setForm((prev) => ({ ...prev, people2: toggleInSelection(prev.people2, ref) }));
            setErrors((prev) => (prev.people2 ? { ...prev, people2: undefined } : prev));
          }}
          itemLabel="NURSES"
          searchPlaceholder="e.g. Aisha Rahman"
          selectedTitle="PEOPLE 2"
          selectedTestKey="people2"
          availableEmpty={noPeople ? "No people set up — add some on the Staff screen." : undefined}
          addAria={(l) => `Add ${l} to people 2`}
          removeAria={(l) => `Remove ${l} from people 2`}
        />
      </FieldShell>

      <FieldShell label="Shift types" required error={errors.shiftTypes}>
        <TransferList<string | number>
          idPrefix="shiftTypes"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={shiftTypes.items}
          groups={shiftTypes.groups}
          selected={form.shiftTypes}
          onToggle={(ref) => {
            // Disabled (numeric-id) options never fire `onToggle` (TransferList
            // renders them with no add affordance), so this is always a genuine
            // string `ShiftTypeRef` at runtime.
            const shiftRef = ref as string;
            setForm((prev) => ({
              ...prev,
              shiftTypes: toggleInSelection(prev.shiftTypes, shiftRef),
            }));
            setErrors((prev) => (prev.shiftTypes ? { ...prev, shiftTypes: undefined } : prev));
          }}
          itemLabel="SHIFT TYPES"
          searchPlaceholder="e.g. Working"
          selectedTitle="SHIFT TYPES"
          selectedTestKey="shiftTypes"
          availableEmpty={
            noShifts ? "No shift types set up — add some on the Shifts screen." : undefined
          }
          addAria={(l) => `Add ${l} to shift types`}
          removeAria={(l) => `Remove ${l} from shift types`}
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
            // Dates is REQUIRED (unlike Coverings' optional date): an empty `[]`
            // means "applies to zero dates", so the ALL chip must emit the
            // explicit all-dates keyword (which also satisfies the non-empty
            // validation) rather than clearing to `[]` — same contract as
            // Counts' countDates.
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
        // FR-PR-18: Affinities uses positive examples (the default encourages).
        placeholder="e.g. 1, 10, ∞"
        onChange={(next) => {
          setForm((prev) => ({ ...prev, weight: next }));
          setErrors((prev) => (prev.weight ? { ...prev, weight: undefined } : prev));
        }}
      />
    </CardEditorForm>
  );
}
