"use client";

// The add/edit form for a shift-type covering (T13, spec 11), rebuilt onto the
// shared ScreenCards chrome (audit M1): the brand-bordered CardEditorForm panel
// with a Description field, two-pane Available/Selected transfer selectors for
// Preceptors, Preceptees, and Shift types (M2 — extending T09's TransferList),
// the prototype's chip+text DateScopeField for Dates (M3), and the locked
// hard-rule note in place of an editable weight (M4 / EDGE-CV-04).
//
// The form edits a flat draft; on a valid submit it hands the draft back to the
// editor, which builds the canonical card and persists exactly one tracked
// mutation. All validation/OFF-LEAVE/numeric-id logic lives in coverings-model.

import { useEffect, useState } from "react";
import type { ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { FaCircleExclamation } from "@/components/icons";
import { CardEditorForm, CardEditorHardRuleNote } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import {
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildPeopleTransferOptions,
  buildShiftTypeTransferOptions,
  type CoveringErrors,
  type CoveringFormState,
  type CoveringRef,
  type CoveringSelectField,
  toggleRef,
  validateCoveringForm,
} from "./coverings-model";

interface CoveringFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: CoveringFormState;
  onSave: (form: CoveringFormState) => void;
  onCancel: () => void;
}

/** Whether a keydown is an IME composition keystroke (spec 11 FR-CV-22 guard). */
function isImeComposition(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing;
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

export function CoveringForm({ state, mode, initialForm, onSave, onCancel }: CoveringFormProps) {
  const [form, setForm] = useState<CoveringFormState>(initialForm);
  const [errors, setErrors] = useState<CoveringErrors>({});

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
  }, [initialForm]);

  const people = buildPeopleTransferOptions(state);
  const shiftTypes = buildShiftTypeTransferOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noShifts = shiftTypes.items.length === 0 && shiftTypes.groups.length === 0;

  function toggle(field: CoveringSelectField, ref: CoveringRef) {
    setForm((prev) => ({ ...prev, [field]: toggleRef(prev[field], ref) }));
    // Per-field error clear on edit (spec 11 FR-CV-17).
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function submit() {
    const nextErrors = validateCoveringForm(form, state);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSave(form);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (isImeComposition(event)) return;
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <CardEditorForm
      heading={mode === "add" ? "Add new covering" : "Edit covering"}
      submitLabel={mode === "add" ? "Add" : "Update"}
      onSubmit={submit}
      onCancel={onCancel}
      onKeyDown={onKeyDown}
    >
      <FieldShell label="Description">
        <Input
          data-testid="covering-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="Short label for this rule"
          className="h-10"
        />
      </FieldShell>

      <FieldShell label="Preceptors" required hint="who must supervise" error={errors.preceptors}>
        <TransferList<CoveringRef>
          idPrefix="preceptors"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={people.items}
          groups={people.groups}
          selected={form.preceptors}
          onToggle={(ref) => toggle("preceptors", ref)}
          itemLabel="NURSES"
          searchPlaceholder="Search people"
          selectedTitle="PRECEPTORS"
          selectedTestKey="preceptors"
          availableEmpty={noPeople ? "No people set up — add some on the Staff screen." : undefined}
          addAria={(l) => `Add ${l} as a preceptor`}
          removeAria={(l) => `Remove ${l} from preceptors`}
        />
      </FieldShell>

      <FieldShell label="Preceptees" required hint="who must be covered" error={errors.preceptees}>
        <TransferList<CoveringRef>
          idPrefix="preceptees"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={people.items}
          groups={people.groups}
          selected={form.preceptees}
          onToggle={(ref) => toggle("preceptees", ref)}
          itemLabel="NURSES"
          searchPlaceholder="Search people"
          selectedTitle="PRECEPTEES"
          selectedTestKey="preceptees"
          availableEmpty={noPeople ? "No people set up — add some on the Staff screen." : undefined}
          addAria={(l) => `Add ${l} as a preceptee`}
          removeAria={(l) => `Remove ${l} from preceptees`}
        />
      </FieldShell>

      <FieldShell
        label="Shift types"
        required
        hint="worked shifts only — OFF and LEAVE are excluded"
        error={errors.shiftTypes}
      >
        <TransferList<CoveringRef>
          idPrefix="shiftTypes"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={shiftTypes.items}
          groups={shiftTypes.groups}
          selected={form.shiftTypes}
          onToggle={(ref) => toggle("shiftTypes", ref)}
          itemLabel="SHIFT TYPES"
          searchPlaceholder="Search shift types"
          selectedTitle="SHIFT TYPES"
          selectedTestKey="shiftTypes"
          availableEmpty={
            noShifts ? "No shift types set up — add some on the Shifts screen." : undefined
          }
          addAria={(l) => `Add ${l} as a covered shift type`}
          removeAria={(l) => `Remove ${l} from covered shift types`}
        />
      </FieldShell>

      <FieldShell label="Dates">
        <DateScopeField
          autoScopes={autoScopes}
          dateGroups={dateGroups}
          dateItems={dateItems}
          value={form.dates}
          onChange={(next) => setForm((prev) => ({ ...prev, dates: next }))}
        />
      </FieldShell>

      {/* Inert weight — a covering is always enforced; the solver ignores its
          weight (spec 11 EDGE-CV-04), so there is no soft/hard dial in the form. */}
      <CardEditorHardRuleNote>
        This covering is <b>always enforced as a hard rule</b> — whenever a preceptee works a
        covered shift, a preceptor must too. The solver ignores weight for coverings, so there is no
        soft/hard dial here.
      </CardEditorHardRuleNote>
    </CardEditorForm>
  );
}
