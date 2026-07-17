"use client";

// The guided add/edit form for a Contracted-Hours shift count (T12 M2a-2). A
// MINIMAL route target that authors the marked card end-to-end: a policy toggle
// (Exact / Range), the target in human hours (converted via the half-hour codec),
// and the same People / Count shift types / Count dates / Description controls the
// ordinary `count-form.tsx` uses. Expression and weight are LOCKED by policy and
// never shown as editable fields.
//
// Out of scope here (M2a-3): the coefficient sub-editor, the coverage-bijection
// commit gate, and the locked expression/weight display polish. The form collects
// coefficients in its draft state (carried through by `buildContractedCard`) but
// does not render an editor for them yet, and Save never hard-blocks on coverage.

import { useEffect, useRef, useState } from "react";
import type { ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { CardEditorForm } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import { FieldShell } from "./count-form";
import {
  buildCountShiftTypeTransferOptions,
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildPeopleTransferOptions,
  toggleInSelection,
} from "./counts-model";
import {
  validateContractedForm,
  type ContractedErrors,
  type ContractedFormState,
} from "./contracted-model";

interface ContractedFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: ContractedFormState;
  onSave: (form: ContractedFormState) => void;
  onCancel: () => void;
}

/** The Exact / Range policy segmented toggle. Selecting a policy locks the
 *  expression/weight encoding downstream (`buildContractedCard`). */
function PolicyToggle({
  policy,
  onChange,
}: {
  policy: "exact" | "range";
  onChange: (next: "exact" | "range") => void;
}) {
  const options: { value: "exact" | "range"; label: string; hint: string }[] = [
    { value: "exact", label: "Exact", hint: "x = T" },
    { value: "range", label: "Range", hint: "min ≤ x ≤ max" },
  ];
  return (
    <div className="inline-flex border border-line2" role="group" aria-label="Contract policy">
      {options.map((option) => {
        const active = policy === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            data-testid={`contracted-policy-${option.value}`}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-2 px-3.5 py-2 text-meta font-semibold ${
              active ? "bg-brand text-brandink" : "bg-transparent text-ink2 hover:bg-panel"
            }`}
          >
            {option.label}
            <span className="font-mono text-label text-ink3">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ContractedForm({
  state,
  mode,
  initialForm,
  onSave,
  onCancel,
}: ContractedFormProps) {
  const [form, setForm] = useState<ContractedFormState>(initialForm);
  const [errors, setErrors] = useState<ContractedErrors>({});

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
  }, [initialForm]);

  const people = buildPeopleTransferOptions(state);
  const shiftTypes = buildCountShiftTypeTransferOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;

  function submit() {
    const nextErrors = validateContractedForm(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSave(form);
  }

  // FR-PR-05 parity with the ordinary form: while VISIBLE, Enter saves (even with
  // modifiers held) and Escape cancels; IME composition is skipped. Latest
  // submit/cancel are read through refs so the listener registers once.
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
      heading={mode === "add" ? "Add contracted hours" : "Edit contracted hours"}
      submitLabel={mode === "add" ? "Add" : "Update"}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <FieldShell label="Description">
        <Input
          data-testid="contracted-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="e.g., Monthly contracted hours"
          className="h-10"
        />
      </FieldShell>

      <FieldShell
        label="Policy"
        hint="Exact locks x = T; Range locks min ≤ x ≤ max — weight is always a hard rule"
      >
        <PolicyToggle
          policy={form.policy}
          onChange={(policy) =>
            setForm((prev) => ({
              ...prev,
              policy,
            }))
          }
        />
      </FieldShell>

      {form.policy === "exact" ? (
        <FieldShell
          label="Contracted hours"
          required
          hint="Whole or half hours — e.g. 160h or 8h 30m"
          error={errors.targetExact}
        >
          <Input
            data-testid="contracted-target-exact"
            aria-label="Contracted hours"
            value={form.targetExact}
            onChange={(e) => {
              const targetExact = e.target.value;
              setForm((prev) => ({ ...prev, targetExact }));
              setErrors((prev) => (prev.targetExact ? { ...prev, targetExact: undefined } : prev));
            }}
            placeholder="160h"
            className="h-10 max-w-[220px]"
          />
        </FieldShell>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldShell label="Minimum hours" required hint="e.g. 150h" error={errors.targetRangeMin}>
            <Input
              data-testid="contracted-target-min"
              aria-label="Minimum hours"
              value={form.targetRangeMin}
              onChange={(e) => {
                const targetRangeMin = e.target.value;
                setForm((prev) => ({ ...prev, targetRangeMin }));
                setErrors((prev) =>
                  prev.targetRangeMin ? { ...prev, targetRangeMin: undefined } : prev,
                );
              }}
              placeholder="150h"
              className="h-10 max-w-[220px]"
            />
          </FieldShell>
          <FieldShell label="Maximum hours" required hint="e.g. 170h" error={errors.targetRangeMax}>
            <Input
              data-testid="contracted-target-max"
              aria-label="Maximum hours"
              value={form.targetRangeMax}
              onChange={(e) => {
                const targetRangeMax = e.target.value;
                setForm((prev) => ({ ...prev, targetRangeMax }));
                setErrors((prev) =>
                  prev.targetRangeMax ? { ...prev, targetRangeMax: undefined } : prev,
                );
              }}
              placeholder="170h"
              className="h-10 max-w-[220px]"
            />
          </FieldShell>
        </div>
      )}

      <FieldShell label="People" required error={errors.person}>
        <TransferList<string | number>
          idPrefix="contracted-people"
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
          selectedTestKey="contracted-people"
          availableEmpty={
            noPeople ? "No people set up — add some on the People screen." : undefined
          }
          addAria={(l) => `Add ${l} to people`}
          removeAria={(l) => `Remove ${l} from people`}
        />
      </FieldShell>

      <FieldShell label="Count shift types" required error={errors.countShiftTypes}>
        <TransferList<string | number>
          idPrefix="contracted-shift-types"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={shiftTypes.items}
          groups={shiftTypes.groups}
          selected={form.countShiftTypes}
          onToggle={(ref) => {
            // Disabled (numeric-id) options never fire `onToggle`, so this is
            // always a genuine string `ShiftTypeRef` at runtime.
            const shiftRef = ref as string;
            setForm((prev) => ({
              ...prev,
              countShiftTypes: toggleInSelection(prev.countShiftTypes, shiftRef),
            }));
            setErrors((prev) =>
              prev.countShiftTypes ? { ...prev, countShiftTypes: undefined } : prev,
            );
          }}
          itemLabel="SHIFT TYPES"
          searchPlaceholder="Search shift types"
          selectedTitle="COUNT SHIFT TYPES"
          selectedTestKey="contracted-shift-types"
          availableEmpty={
            shiftTypes.items.length === 0 && shiftTypes.groups.length === 0
              ? "No shift types set up — add some on the Shift Types screen."
              : undefined
          }
          addAria={(l) => `Add ${l} to count shift types`}
          removeAria={(l) => `Remove ${l} from count shift types`}
        />
      </FieldShell>

      <FieldShell label="Count dates" required error={errors.countDates}>
        {noDates ? (
          <p className="border border-line bg-panel px-3.5 py-3 text-center text-meta italic text-ink3">
            No dates available. Please set up dates in the Dates screen first.
          </p>
        ) : (
          <DateScopeField
            autoScopes={autoScopes}
            dateGroups={dateGroups}
            dateItems={dateItems}
            allValue={["ALL"]}
            value={form.countDates}
            onChange={(next) => {
              setForm((prev) => ({ ...prev, countDates: next }));
              setErrors((prev) => (prev.countDates ? { ...prev, countDates: undefined } : prev));
            }}
          />
        )}
      </FieldShell>
    </CardEditorForm>
  );
}
