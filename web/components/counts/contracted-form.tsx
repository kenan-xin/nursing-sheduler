"use client";

// The guided add/edit form for a Contracted-Hours shift count (T12 M2a-3). The
// full guided editor that authors the marked card end-to-end: a policy toggle
// (Exact / Range), the target in human hours (converted via the half-hour codec),
// the shared per-shift-type coefficient sub-editor wired over the CONCRETE day-state
// expansion, a read-only view of the locked expression/weight encoding, and a
// collapsible Solver-details section exposing the raw stored encoding plus a raw
// half-hour target override. Save is gated by the SHARED coverage validator
// (`validateContractedCommit` → `validateContractedHoursContract`): a draft with
// incomplete/extra/invalid coverage is blocked with the error in place and the
// draft stays recoverable, never silently dropped.
//
// Expression and weight are LOCKED by policy — changing them requires converting to
// a generic Shift Count (the Convert action itself is M2a-4; only the note lives
// here). Refresh-from-Shift-Types derivation is M2a-5; coefficients are entered
// MANUALLY here.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { CardEditorForm } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import {
  CoefficientFields,
  syncCoefficientPairs,
} from "@/components/card-editor/coefficient-fields";
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
  buildContractedCoefficientDomain,
  contractedCoefficientIds,
  hasContractedErrors,
  validateContractedCommit,
  type ContractedErrors,
  type ContractedFormState,
} from "./contracted-model";
import {
  applyContractedRefresh,
  deriveContractedRefresh,
  type RefreshCategory,
  type RefreshPreview,
  type RefreshRow,
} from "./refresh-model";
import { formatHalfHours, parseHalfHours, parseRawHalfHours } from "./half-hour-codec";

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

/** The read-only rows for the encoding the policy locks: the solver expression and
 *  the hard (`+∞`) weight, with the note that changing them needs a convert. */
function LockedEncoding({
  policy,
  expressionError,
  weightError,
}: {
  policy: "exact" | "range";
  expressionError?: string;
  weightError?: string;
}) {
  const expressionText = policy === "range" ? "x ≥ T and x ≤ T" : "x = T";
  return (
    <div
      className="flex flex-col gap-2 border border-line2 bg-panel p-3.5"
      data-testid="contracted-locked-encoding"
    >
      <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        Locked encoding
      </span>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-label font-semibold text-ink3">Expression</span>
          <span className="font-mono text-meta text-ink" data-testid="contracted-locked-expression">
            {expressionText}
          </span>
          {expressionError && (
            <span className="text-meta font-semibold text-error">{expressionError}</span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-label font-semibold text-ink3">Weight</span>
          <span className="font-mono text-meta text-ink" data-testid="contracted-locked-weight">
            Hard (∞)
          </span>
          {weightError && <span className="text-meta font-semibold text-error">{weightError}</span>}
        </div>
      </div>
      <p className="text-meta italic text-ink3">
        Expression and weight are fixed by the policy. Changing them requires converting this rule
        to a generic Shift Count.
      </p>
    </div>
  );
}

/**
 * Solver-details escape hatch (DL09 D10): a collapsed section that shows the exact
 * `{ expression, target, weight }` the card will serialize and offers a RAW
 * half-hour target editor (integer half-hours, not the human-hours codec) kept in
 * two-way sync with the human-hours target inputs. Coefficients are already raw
 * half-hour integers in the coefficient sub-editor, so no duplicate editor is
 * needed here.
 */
function SolverDetails({
  form,
  onRawTargetChange,
}: {
  form: ContractedFormState;
  onRawTargetChange: (patch: Partial<ContractedFormState>) => void;
}) {
  const isRange = form.policy === "range";
  const expressionText = isRange ? '["x >= T", "x <= T"]' : '"x = T"';
  const rawExact = parseHalfHours(form.targetExact);
  const rawMin = parseHalfHours(form.targetRangeMin);
  const rawMax = parseHalfHours(form.targetRangeMax);
  const targetText = isRange ? `[${rawMin ?? "?"}, ${rawMax ?? "?"}]` : String(rawExact ?? "?");

  // A raw half-hour edit writes straight back through the human-hours field so the
  // two views never drift; a cleared/non-integer raw value clears the human field.
  const setRaw = (key: "targetExact" | "targetRangeMin" | "targetRangeMax", raw: string) => {
    if (raw === "") {
      onRawTargetChange({ [key]: "" });
      return;
    }
    // Strict integer half-hours — reject (don't truncate) "3.5"/"1e3"/negatives so a
    // malformed raw edit can never silently rewrite the target to a different value.
    const half = parseRawHalfHours(raw);
    if (half === null) return;
    onRawTargetChange({ [key]: formatHalfHours(half) });
  };

  return (
    <details className="border border-line2 bg-panel" data-testid="contracted-solver-details">
      <summary
        className="cursor-pointer px-3.5 py-2 text-label font-semibold uppercase tracking-[0.03em] text-ink2"
        data-testid="contracted-solver-details-toggle"
      >
        Solver details
      </summary>
      <div className="flex flex-col gap-3 border-t border-line2 p-3.5">
        <pre
          className="whitespace-pre-wrap font-mono text-label text-ink2"
          data-testid="contracted-raw-encoding"
        >
          {`expression: ${expressionText}\ntarget: ${targetText}\nweight: .inf`}
        </pre>
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Raw target (half-hours)
          </span>
          {isRange ? (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-label text-ink3">Minimum</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  data-testid="contracted-raw-target-min"
                  aria-label="Raw minimum target in half-hours"
                  value={rawMin ?? ""}
                  onChange={(e) => setRaw("targetRangeMin", e.target.value)}
                  className="h-9 w-28 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-label text-ink3">Maximum</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  data-testid="contracted-raw-target-max"
                  aria-label="Raw maximum target in half-hours"
                  value={rawMax ?? ""}
                  onChange={(e) => setRaw("targetRangeMax", e.target.value)}
                  className="h-9 w-28 font-mono"
                />
              </label>
            </div>
          ) : (
            <Input
              type="number"
              min={0}
              step={1}
              data-testid="contracted-raw-target"
              aria-label="Raw target in half-hours"
              value={rawExact ?? ""}
              onChange={(e) => setRaw("targetExact", e.target.value)}
              className="h-9 w-28 font-mono"
            />
          )}
          <span className="text-meta italic text-ink3">
            Integer half-hours (2 per hour) — stays in sync with the hours field above.
          </span>
        </div>
      </div>
    </details>
  );
}

/** Human labels + copy for each Refresh preview category, in display order. */
const REFRESH_CATEGORIES: { key: RefreshCategory; label: string; hint: string }[] = [
  { key: "added", label: "Added", hint: "Filled in from the shift's working time." },
  { key: "changed", label: "Changed", hint: "Replaces the current manual value." },
  { key: "unchanged", label: "Unchanged", hint: "Already matches the derived value." },
  {
    key: "non-derivable",
    label: "Non-derivable",
    hint: "No valid working time — the existing value is kept; enter one manually.",
  },
  { key: "removed", label: "Removed", hint: "No longer a selected shift type — dropped." },
];

/** One previewed value as display text: the derived coefficient, or the kept manual
 *  value for a non-derivable/removed row (blank ⇒ an em-dash placeholder). */
function refreshRowValueText(row: RefreshRow): string {
  if (row.derived !== null) return String(row.derived);
  return row.current === "" ? "—" : `${row.current} (kept)`;
}

/**
 * The Refresh-from-Shift-Types preview: a non-mutating panel that categorizes every
 * concrete coefficient id against its Shift-Type-derived value (added / changed /
 * unchanged / non-derivable / removed). Confirm applies the derivation to the draft;
 * Cancel dismisses it without applying anything. Explicit-only — it never runs on
 * mount or selector change.
 */
function RefreshPanel({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: RefreshPreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-3 border border-line2 bg-panel p-3.5"
      data-testid="contracted-refresh-preview"
    >
      <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        Refresh preview
      </span>
      {REFRESH_CATEGORIES.map(({ key, label, hint }) => {
        const rows = preview.rows.filter((row) => row.category === key);
        if (rows.length === 0) return null;
        return (
          <div
            key={key}
            className="flex flex-col gap-1.5"
            data-testid={`contracted-refresh-${key}`}
          >
            <span className="text-label font-semibold text-ink3">
              {label} ({rows.length})
            </span>
            <span className="text-meta italic text-ink3">{hint}</span>
            <div className="flex flex-wrap gap-2">
              {rows.map((row) => (
                <span
                  key={row.id}
                  className="border border-line2 px-2 py-1 font-mono text-meta text-ink"
                  data-testid={`contracted-refresh-row-${row.id}`}
                  data-category={row.category}
                >
                  {row.id}: {refreshRowValueText(row)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {preview.unresolved.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="contracted-refresh-unresolved">
          <span className="text-label font-semibold text-ink3">
            Non-derivable — unresolved ({preview.unresolved.length})
          </span>
          <span className="text-meta italic text-ink3">
            These selected shift types can&apos;t be resolved — fix the selection.
          </span>
          <div className="flex flex-wrap gap-2">
            {preview.unresolved.map((id) => (
              <span
                key={id}
                className="border border-warn px-2 py-1 font-mono text-meta text-warn"
                data-testid={`contracted-refresh-unresolved-${id}`}
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="contracted-refresh-confirm"
          onClick={onConfirm}
          className="border border-brand bg-brand px-3.5 py-2 text-meta font-semibold text-brandink"
        >
          Confirm
        </button>
        <button
          type="button"
          data-testid="contracted-refresh-cancel"
          onClick={onCancel}
          className="border border-line2 px-3.5 py-2 text-meta font-semibold text-ink2 hover:bg-panel"
        >
          Cancel
        </button>
      </div>
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
  // The pending Refresh preview (M2a-5). Non-null only between an explicit Refresh
  // click and its Confirm/Cancel — the derivation NEVER runs on mount or selector
  // change, and Confirm is the only path that mutates the draft's coefficients.
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
    setRefreshPreview(null);
  }, [initialForm]);

  const people = buildPeopleTransferOptions(state);
  const shiftTypes = buildCountShiftTypeTransferOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;

  // The CONCRETE coefficient domain (backend expansion, leaf sources only) — the
  // exact day-state set the coverage bijection is defined over. Its own ids are the
  // `selection` the sub-editor eligibility is derived from.
  const coefficientDomain = useMemo(
    () => buildContractedCoefficientDomain(state, form.countShiftTypes),
    [state, form.countShiftTypes],
  );
  const coefficientSelection = useMemo(
    () => contractedCoefficientIds(coefficientDomain),
    [coefficientDomain],
  );

  function clearCoefficientErrors(prev: ContractedErrors): ContractedErrors {
    return prev.coefficientErrorsById || prev.coefficientAggregate
      ? { ...prev, coefficientErrorsById: undefined, coefficientAggregate: undefined }
      : prev;
  }

  function submit() {
    const nextErrors = validateContractedCommit(form, state);
    if (hasContractedErrors(nextErrors)) {
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

      <LockedEncoding
        policy={form.policy}
        expressionError={errors.expression}
        weightError={errors.weight}
      />

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

      <FieldShell
        label="Count shift types"
        required
        hint="Each selected worked shift and LEAVE needs a half-hour coefficient below"
        error={errors.countShiftTypes}
      >
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
            setForm((prev) => {
              const nextShiftTypes = toggleInSelection(prev.countShiftTypes, shiftRef);
              // Re-sync coefficient pairs to the newly-eligible CONCRETE ids in the
              // same update (FR-PR-73 parity with count-form) so re-adding a source
              // yields a fresh blank row and coverage lines up with the bijection.
              const nextDomain = buildContractedCoefficientDomain(state, nextShiftTypes);
              return {
                ...prev,
                countShiftTypes: nextShiftTypes,
                countShiftTypeCoefficients: syncCoefficientPairs(
                  contractedCoefficientIds(nextDomain),
                  prev.countShiftTypeCoefficients,
                  nextDomain,
                ),
              };
            });
            setErrors((prev) => {
              const cleared = clearCoefficientErrors(prev);
              return cleared.countShiftTypes ? { ...cleared, countShiftTypes: undefined } : cleared;
            });
            // A pending preview was derived against the OLD selection — dismiss it so
            // Confirm can never apply a stale derivation to the new concrete domain.
            setRefreshPreview(null);
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

      {coefficientSelection.length > 0 && (
        <p className="text-meta italic text-ink3" data-testid="contracted-expanded-ids">
          Concrete coverage: {coefficientSelection.join(", ")}
        </p>
      )}

      <CoefficientFields
        selection={coefficientSelection}
        pairs={form.countShiftTypeCoefficients}
        domain={coefficientDomain}
        label="Shift Type"
        testId="contracted-coefficient-fields"
        errorsById={errors.coefficientErrorsById}
        // Always surface the aggregate. Unlike count-form (where the aggregate is the
        // mutually-exclusive overlap message), the contracted helper can emit a per-id
        // error AND a simultaneous incomplete/extra-coverage aggregate — they are
        // distinct concerns, so suppressing the aggregate would drop a required error.
        aggregateError={errors.coefficientAggregate}
        onChange={(next) => {
          setForm((prev) => ({ ...prev, countShiftTypeCoefficients: next }));
          setErrors((prev) => clearCoefficientErrors(prev));
          // A pending preview was derived against the pre-edit coefficients; dismiss
          // it so a stale snapshot can never be Confirmed over the manual edit.
          setRefreshPreview(null);
        }}
      />

      {form.countShiftTypes.length > 0 && (
        <div className="flex flex-col gap-2">
          <div>
            <button
              type="button"
              data-testid="contracted-refresh-button"
              onClick={() => setRefreshPreview(deriveContractedRefresh(form, state))}
              className="border border-line2 px-3.5 py-2 text-meta font-semibold text-ink2 hover:bg-panel"
            >
              Refresh from Shift Types
            </button>
            <p className="mt-1 text-meta italic text-ink3">
              Preview coefficients derived from each shift&apos;s working time (LEAVE credited at{" "}
              8h). Nothing changes until you Confirm.
            </p>
          </div>
          {refreshPreview && (
            <RefreshPanel
              preview={refreshPreview}
              onConfirm={() => {
                setForm((prev) => applyContractedRefresh(prev, refreshPreview));
                setErrors((prev) => clearCoefficientErrors(prev));
                setRefreshPreview(null);
              }}
              onCancel={() => setRefreshPreview(null)}
            />
          )}
        </div>
      )}

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

      <SolverDetails
        form={form}
        onRawTargetChange={(patch) => {
          setForm((prev) => ({ ...prev, ...patch }));
          setErrors((prev) => {
            if (!prev.targetExact && !prev.targetRangeMin && !prev.targetRangeMax) return prev;
            return {
              ...prev,
              targetExact: undefined,
              targetRangeMin: undefined,
              targetRangeMax: undefined,
            };
          });
        }}
      />
    </CardEditorForm>
  );
}
