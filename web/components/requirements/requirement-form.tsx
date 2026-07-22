"use client";

// The add/edit form for a staffing requirement (T12 M1 clone, spec 05
// FR-PR-20..29). Composes the shared ScreenCards form panel with a Description
// field, the LOCAL single-select `ShiftTypeSingleSelect` radio (FR-PR-21) + the
// shared `CoefficientFields` staffing-multiplier sub-editor, Required/Preferred
// number inputs (FR-PR-22/23, EDGE-PR-04/05), the shared `TransferList` for
// Qualified People, the shared `DateScopeField` for Dates, and the CONDITIONAL
// `WeightField` (dial only when preferred differs from required — FR-PR-24).
//
// The form edits a flat draft; on a valid submit it hands the draft back to the
// editor, which builds the canonical card and persists exactly one tracked
// mutation. All validation/build/load logic lives in requirements-model.

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
import { WeightField } from "@/components/card-editor/weight-field";
import { ShiftTypeSingleSelect } from "./shift-type-single-select";
import {
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildQualifiedPeopleTransferOptions,
  buildRequirementShiftTypeDomain,
  buildRequirementShiftTypeOptions,
  preferredDiffersFromRequired,
  selectShiftType,
  validateRequirementForm,
  type RequirementErrors,
  type RequirementFormState,
  type RequirementNumberValue,
} from "./requirements-model";

interface RequirementFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: RequirementFormState;
  onSave: (form: RequirementFormState) => void;
  onCancel: () => void;
}

const WEIGHT_NOTE =
  "Weight is not needed when the preferred number of people equals the required number.";
const WEIGHT_HELP =
  "Penalty applied when the preferred number of people isn't met (the more negative, the higher the penalty). -Infinity makes it a hard requirement.";
const PREFERRED_HELP =
  "Defaults to Required if left empty. Set higher to make extra staffing a soft goal (a weight then applies).";

/** Parse a Required/Preferred number input as an integer (FR-PR-22/23): blank
 *  stays blank; a `NaN` parse keeps the raw text so the verbatim validator can
 *  reject it; otherwise `parseInt` truncates (`2.9` → `2`), mirroring the shared
 *  `parseCoefficientInput`/`parseWeightInput` contract. */
function parseRequirementInteger(raw: string): RequirementNumberValue {
  if (raw === "") return "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? raw : parsed;
}

/** Blur a number input on wheel so scrolling past a focused field cannot change
 *  staffing accidentally (EDGE-PR-12). */
function blurOnWheel(e: React.WheelEvent<HTMLInputElement>) {
  (e.target as HTMLInputElement).blur();
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

export function RequirementForm({
  state,
  mode,
  initialForm,
  onSave,
  onCancel,
}: RequirementFormProps) {
  const [form, setForm] = useState<RequirementFormState>(initialForm);
  const [errors, setErrors] = useState<RequirementErrors>({});

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
  }, [initialForm]);

  const domain = buildRequirementShiftTypeDomain(state);
  const shiftTypeOptions = buildRequirementShiftTypeOptions(state);
  const people = buildQualifiedPeopleTransferOptions(state);
  // FR-PR-14: the empty-people guidance must render when the scenario has NO
  // people AND no people groups. The option builder appends a synthetic ALL group,
  // so the TransferList's own empty check (`items.length === 0 && groups.length === 0`)
  // is permanently false — compute `noPeople` from the source state here, before
  // that injection, and render the setup guidance instead of the picker.
  const noPeople = state.staff.length === 0 && state.staffGroups.length === 0;
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;
  const diff = preferredDiffersFromRequired(form);

  function submit() {
    const nextErrors = validateRequirementForm(form, domain);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSave(form);
  }

  // FR-PR-05: while the form is VISIBLE, a global handler makes Enter save (even
  // with Shift/Alt/Ctrl/Meta held) and Escape cancel. IME composition is skipped
  // via `isComposing` OR the legacy `keyCode === 229`. Latest submit/cancel are
  // read through refs so the listener registers once.
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

  function onRequiredChange(raw: string) {
    const nextRequired: RequirementFormState["requiredNumPeople"] = parseRequirementInteger(raw);
    setForm((prev) => {
      // EDGE-PR-04: a required value that now equals the current preferred value
      // resets preferred to unset (hiding the weight dial in the same update).
      const prefEqualsNewRequired =
        typeof nextRequired === "number" &&
        prev.preferredNumPeople !== "" &&
        Number(prev.preferredNumPeople) === nextRequired;
      return {
        ...prev,
        requiredNumPeople: nextRequired,
        preferredNumPeople: prefEqualsNewRequired ? "" : prev.preferredNumPeople,
      };
    });
    setErrors((prev) =>
      prev.requiredNumPeople ? { ...prev, requiredNumPeople: undefined } : prev,
    );
  }

  function onPreferredChange(raw: string) {
    if (raw === "") {
      setForm((prev) => ({ ...prev, preferredNumPeople: "" }));
      setErrors((prev) =>
        prev.preferredNumPeople ? { ...prev, preferredNumPeople: undefined } : prev,
      );
      return;
    }
    const numValue = Number.parseInt(raw, 10);
    setForm((prev) => {
      // A parse-to-NaN keeps the previous preferred value (FR-PR-23).
      if (Number.isNaN(numValue)) return prev;
      // EDGE-PR-05: a preferred value equal to required normalizes to unset.
      const required = prev.requiredNumPeople;
      if (typeof required === "number" && numValue === required) {
        return { ...prev, preferredNumPeople: "" };
      }
      // FR-PR-22/23: integer parsing — `2.9` truncates to `2`, mirroring the
      // shared number-input contract (`parseCoefficientInput`/`parseWeightInput`).
      return { ...prev, preferredNumPeople: numValue };
    });
    setErrors((prev) =>
      prev.preferredNumPeople ? { ...prev, preferredNumPeople: undefined } : prev,
    );
  }

  return (
    <CardEditorForm
      heading={mode === "add" ? "Add new requirement" : "Edit requirement"}
      submitLabel={mode === "add" ? "Add" : "Update"}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <FieldShell label="Description">
        <Input
          data-testid="requirement-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="e.g., Night shifts need senior nurses"
          className="h-10"
        />
      </FieldShell>

      <FieldShell label="Shift type" required error={errors.shiftType}>
        <ShiftTypeSingleSelect
          items={shiftTypeOptions.items}
          groups={shiftTypeOptions.groups}
          selected={form.shiftType}
          onSelect={(value) => {
            setForm((prev) => {
              const nextShiftType = selectShiftType(value as string);
              // FR-PR-73: re-sync coefficient pairs to the newly-eligible ids in
              // the SAME update.
              return {
                ...prev,
                shiftType: nextShiftType,
                shiftTypeCoefficients: syncCoefficientPairs(
                  nextShiftType,
                  prev.shiftTypeCoefficients,
                  domain,
                ),
              };
            });
            setErrors((prev) =>
              prev.shiftType || prev.coefficients
                ? {
                    ...prev,
                    shiftType: undefined,
                    coefficients: undefined,
                    coefficientErrorsById: undefined,
                  }
                : prev,
            );
          }}
        />
      </FieldShell>

      <CoefficientFields
        selection={form.shiftType}
        pairs={form.shiftTypeCoefficients}
        domain={domain}
        label="Shift Type"
        showCoverage={false}
        note="How much one assignment counts toward the required headcount. Default is 1 (one person = one unit of coverage). Raise it when a single assignment is worth more than one — e.g. a senior on D_sup with a coefficient of 2 counts as two toward the staffing minimum because they can supervise, so one senior satisfies a requirement of 2. This is a coverage-value weight per person, not hours (no auto-fill)."
        errorsById={errors.coefficientErrorsById}
        aggregateError={
          errors.coefficientErrorsById && Object.keys(errors.coefficientErrorsById).length > 0
            ? undefined
            : errors.coefficients
        }
        onChange={(next) => {
          setForm((prev) => ({ ...prev, shiftTypeCoefficients: next }));
          setErrors((prev) =>
            prev.coefficients || prev.coefficientErrorsById
              ? { ...prev, coefficients: undefined, coefficientErrorsById: undefined }
              : prev,
          );
        }}
      />

      <div className="flex flex-wrap gap-5">
        <FieldShell label="Required number of people" required error={errors.requiredNumPeople}>
          <input
            type="number"
            min={0}
            step={1}
            data-testid="requirement-required"
            aria-label="Required number of people"
            value={form.requiredNumPeople}
            onChange={(e) => onRequiredChange(e.target.value)}
            onWheel={blurOnWheel}
            className="h-10 w-[132px] border border-line bg-surface px-3 font-mono font-bold"
          />
        </FieldShell>

        <FieldShell
          label="Preferred number of people"
          hint={PREFERRED_HELP}
          error={errors.preferredNumPeople}
        >
          <input
            type="number"
            min={1}
            step={1}
            data-testid="requirement-preferred"
            aria-label="Preferred number of people"
            value={form.preferredNumPeople}
            onChange={(e) => onPreferredChange(e.target.value)}
            onWheel={blurOnWheel}
            placeholder="= Required"
            className="h-10 w-[132px] border border-line bg-surface px-3 font-mono font-bold"
          />
        </FieldShell>
      </div>

      <FieldShell label="Qualified people" required error={errors.qualifiedPeople}>
        {noPeople ? (
          <p className="border border-line bg-panel px-3.5 py-3 text-center text-meta italic text-ink3">
            No people set up — add some on the People screen first.
          </p>
        ) : (
          <TransferList<string | number>
            idPrefix="qualified"
            keyOf={entityKey}
            sameValue={sameEntityId}
            items={people.items}
            groups={people.groups}
            selected={form.qualifiedPeople}
            onToggle={(ref) => {
              setForm((prev) => ({
                ...prev,
                qualifiedPeople: prev.qualifiedPeople.some((r) => sameEntityId(r, ref))
                  ? prev.qualifiedPeople.filter((r) => !sameEntityId(r, ref))
                  : [...prev.qualifiedPeople, ref],
              }));
              setErrors((prev) =>
                prev.qualifiedPeople ? { ...prev, qualifiedPeople: undefined } : prev,
              );
            }}
            itemLabel="NURSES"
            searchPlaceholder="Search people"
            selectedTitle="QUALIFIED"
            selectedTestKey="qualified"
            availableEmpty={
              people.items.length === 0 && people.groups.length === 0
                ? "No people set up — add some on the People screen."
                : undefined
            }
            addAria={(l) => `Add ${l} to qualified people`}
            removeAria={(l) => `Remove ${l} from qualified people`}
          />
        )}
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
            // FR-PR-27: Dates is REQUIRED; the ALL chip must emit the explicit
            // all-dates keyword (never clear to `[]`, which would fail validation).
            allValue={["ALL"]}
            value={form.date}
            onChange={(next) => {
              setForm((prev) => ({ ...prev, date: next }));
              setErrors((prev) => (prev.date ? { ...prev, date: undefined } : prev));
            }}
          />
        )}
      </FieldShell>

      {diff ? (
        <WeightField
          value={form.weight}
          error={errors.weight}
          help={WEIGHT_HELP}
          onChange={(next) => {
            setForm((prev) => ({ ...prev, weight: next }));
            setErrors((prev) => (prev.weight ? { ...prev, weight: undefined } : prev));
          }}
        />
      ) : (
        <WeightField value={form.weight} onChange={() => {}} note={WEIGHT_NOTE} />
      )}
    </CardEditorForm>
  );
}
