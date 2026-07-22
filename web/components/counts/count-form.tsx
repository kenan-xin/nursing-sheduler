"use client";

// The add/edit form for a shift count (T12 seed, spec 05 FR-PR-50..55). Composes
// the shared ScreenCards form panel with a Description field, two-pane transfer
// selectors for People + Count Shift Types (extending T09's TransferList), the
// prototype's chip+text DateScopeField for Count Dates, the shared
// CoefficientFields sub-editor, the shared ExpressionField (6 ops + Target), and
// the shared WeightField soft/hard dial.
//
// The form edits a flat draft; on a valid submit it hands the draft back to the
// editor, which builds the canonical card and persists exactly one tracked
// mutation. All validation/build/load logic lives in counts-model.

import { useEffect, useRef, useState } from "react";
import type { ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { FaCircleExclamation } from "@/components/icons";
import { CardEditorForm } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import {
  CoefficientFields,
  syncCoefficientPairs,
} from "@/components/card-editor/coefficient-fields";
import { ExpressionField } from "@/components/card-editor/expression-field";
import { WeightField } from "@/components/card-editor/weight-field";
import {
  buildCountShiftTypeDomain,
  buildCountShiftTypeTransferOptions,
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildPeopleTransferOptions,
  toggleInSelection,
  validateCountForm,
  type CountErrors,
  type CountFormState,
} from "./counts-model";

interface CountFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: CountFormState;
  onSave: (form: CountFormState) => void;
  onCancel: () => void;
}

/** The prototype's per-field shell: an uppercase label, an optional inline hint,
 *  the control, and the verbatim validation error line. Shared with the sibling
 *  contracted-hours form so both authoring flows render identical field chrome. */
export function FieldShell({
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

export function CountForm({ state, mode, initialForm, onSave, onCancel }: CountFormProps) {
  const [form, setForm] = useState<CountFormState>(initialForm);
  const [errors, setErrors] = useState<CountErrors>({});

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
  }, [initialForm]);

  const domain = buildCountShiftTypeDomain(state);
  const people = buildPeopleTransferOptions(state);
  const shiftTypes = buildCountShiftTypeTransferOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;

  function submit() {
    const nextErrors = validateCountForm(form, domain);
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
  // re-add per keystroke).
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
      heading={mode === "add" ? "Add new shift count" : "Edit shift count"}
      submitLabel={mode === "add" ? "Add" : "Update"}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <FieldShell label="Description">
        <Input
          data-testid="count-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="e.g., Working shifts should be close to the average"
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
          availableEmpty={
            noPeople ? "No people set up — add some on the People screen." : undefined
          }
          addAria={(l) => `Add ${l} to people`}
          removeAria={(l) => `Remove ${l} from people`}
        />
      </FieldShell>

      <FieldShell label="Count shift types" required error={errors.countShiftTypes}>
        <TransferList<string | number>
          idPrefix="count-shift-types"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={shiftTypes.items}
          groups={shiftTypes.groups}
          selected={form.countShiftTypes}
          onToggle={(ref) => {
            // Disabled (numeric-id) options never fire `onToggle` (TransferList
            // renders them with no add affordance), so this is always a genuine
            // string `ShiftTypeRef` at runtime.
            const shiftRef = ref as string;
            setForm((prev) => {
              const nextShiftTypes = toggleInSelection(prev.countShiftTypes, shiftRef);
              // FR-PR-73: re-sync coefficient pairs to the newly-eligible ids in the
              // SAME update — drop a removed source's value so re-adding it yields a
              // fresh blank row (not its stale prior value).
              return {
                ...prev,
                countShiftTypes: nextShiftTypes,
                countShiftTypeCoefficients: syncCoefficientPairs(
                  nextShiftTypes,
                  prev.countShiftTypeCoefficients,
                  domain,
                ),
              };
            });
            setErrors((prev) =>
              prev.countShiftTypes || prev.coefficients
                ? {
                    ...prev,
                    countShiftTypes: undefined,
                    coefficients: undefined,
                    coefficientErrorsById: undefined,
                  }
                : prev,
            );
          }}
          itemLabel="SHIFT TYPES"
          searchPlaceholder="Search shift types"
          selectedTitle="COUNT SHIFT TYPES"
          selectedTestKey="count-shift-types"
          availableEmpty={
            shiftTypes.items.length === 0 && shiftTypes.groups.length === 0
              ? "No shift types set up — add some on the Shift Types screen."
              : undefined
          }
          addAria={(l) => `Add ${l} to count shift types`}
          removeAria={(l) => `Remove ${l} from count shift types`}
        />
      </FieldShell>

      <CoefficientFields
        selection={form.countShiftTypes}
        pairs={form.countShiftTypeCoefficients}
        domain={domain}
        label="Count Shift Type"
        showCoverage={false}
        note="Each selected shift type counts toward x by its coefficient (a positive integer, default 1). x is the weighted sum over the selected people, shift types and dates; compare it to your target with the expression above. For an hours-based monthly target, use Add Contracted Hours instead."
        errorsById={errors.coefficientErrorsById}
        // `errors.coefficients` holds the joined per-id messages when per-id errors
        // exist (already shown inline via errorsById) OR the overlap message when
        // every value is individually valid — surface the aggregate only in the
        // latter case so nothing double-renders (M2).
        aggregateError={
          errors.coefficientErrorsById && Object.keys(errors.coefficientErrorsById).length > 0
            ? undefined
            : errors.coefficients
        }
        onChange={(next) => {
          setForm((prev) => ({ ...prev, countShiftTypeCoefficients: next }));
          setErrors((prev) =>
            prev.coefficients || prev.coefficientErrorsById
              ? { ...prev, coefficients: undefined, coefficientErrorsById: undefined }
              : prev,
          );
        }}
      />

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
            // countDates is REQUIRED: an empty `[]` means "count over zero dates",
            // so the ALL chip must emit the explicit all-dates keyword (which also
            // satisfies the non-empty validation) rather than clearing to `[]`.
            allValue={["ALL"]}
            value={form.countDates}
            onChange={(next) => {
              setForm((prev) => ({ ...prev, countDates: next }));
              setErrors((prev) => (prev.countDates ? { ...prev, countDates: undefined } : prev));
            }}
          />
        )}
      </FieldShell>

      <ExpressionField
        expression={form.expression}
        target={form.target}
        error={errors.expression ?? errors.target}
        onChange={({ expression, target }) => {
          setForm((prev) => ({ ...prev, expression, target }));
          setErrors((prev) =>
            prev.expression || prev.target || prev.weight
              ? { ...prev, expression: undefined, target: undefined, weight: undefined }
              : prev,
          );
        }}
      />

      <WeightField
        value={form.weight}
        error={errors.weight}
        onChange={(next) => {
          setForm((prev) => ({ ...prev, weight: next }));
          setErrors((prev) => (prev.weight ? { ...prev, weight: undefined } : prev));
        }}
      />
    </CardEditorForm>
  );
}
