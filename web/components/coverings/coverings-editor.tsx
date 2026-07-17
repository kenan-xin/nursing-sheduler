"use client";

// Shift Type Coverings editor (T13, spec 11), rebuilt onto the shared ScreenCards
// chrome (audit M1/m1/m2). The orchestrator composes the prototype header (eyebrow,
// display title, full subtitle, inline top-right Add), the persistent "exact
// constraints" info strip, the add/edit form, the list heading with a live rule
// count, the centred empty state (shown only with no rules AND no open draft), and
// the saved-card list. The store slice remains the single source of truth; the form
// is a transient draft that only touches state through the `useCoverings`
// operations (one tracked mutation each).

import { useState } from "react";
import {
  CardEditorScreen,
  CardEditorHeader,
  CardEditorInfoStrip,
  CardListHeading,
  CardEditorEmptyState,
} from "@/components/card-editor/card-editor-shell";
import { CoveringForm } from "./covering-form";
import { CoveringCardList } from "./covering-card-list";
import { useCoverings } from "./use-coverings";
import { coveringToForm, emptyCoveringForm, type CoveringFormState } from "./coverings-model";

type Draft =
  | { mode: "add"; uid: null; form: CoveringFormState }
  | { mode: "edit"; uid: string; form: CoveringFormState };

const EYEBROW = "CONSTRAINT · SHIFT TYPE COVERINGS";
const TITLE = "Shift Type Coverings";
const SUBTITLE =
  "A separate hard constraint: whenever a preceptee works a chosen shift type, at least one of their preceptors must be on the same shift. Distinct from affinities, which only encourage people to work together.";
const ADD_LABEL = "Add shift type covering";
const LIST_TITLE = "Current shift type coverings";
const EMPTY_TITLE = "No covering rules yet.";
const EMPTY_BODY = "Add your first covering to define this constraint.";

export function CoveringsEditor() {
  const { state, coverings, add, update, remove, duplicate, move, reorder, setDisabled } =
    useCoverings();
  const [draft, setDraft] = useState<Draft | null>(null);

  function openAdd() {
    // The Add toggle also closes an open draft (spec 11 FR-CV-03).
    setDraft(draft ? null : { mode: "add", uid: null, form: emptyCoveringForm() });
  }

  function openEdit(uid: string) {
    const card = coverings.find((c) => c.uid === uid);
    if (card) setDraft({ mode: "edit", uid, form: coveringToForm(card) });
  }

  function save(form: CoveringFormState) {
    if (draft?.mode === "edit") update(draft.uid, form);
    else add(form);
    setDraft(null);
  }

  // List ops cancel any open draft first (spec 11 EDGE-CV-06).
  function withDraftDismissed(op: () => void) {
    setDraft(null);
    op();
  }

  return (
    <CardEditorScreen screen="Shift Type Coverings">
      <CardEditorHeader
        eyebrow={EYEBROW}
        title={TITLE}
        subtitle={SUBTITLE}
        addLabel={ADD_LABEL}
        formOpen={!!draft}
        onAdd={openAdd}
      />
      <CardEditorInfoStrip />

      {draft && (
        <CoveringForm
          // Remount on target change so the form resets cleanly per draft.
          key={draft.uid ?? "add"}
          state={state}
          mode={draft.mode}
          initialForm={draft.form}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      )}

      <CardListHeading title={LIST_TITLE} count={coverings.length} />

      {coverings.length === 0 && !draft ? (
        <CardEditorEmptyState
          title={EMPTY_TITLE}
          body={EMPTY_BODY}
          addLabel={ADD_LABEL}
          onAdd={openAdd}
        />
      ) : coverings.length > 0 ? (
        <CoveringCardList
          coverings={coverings}
          onEdit={openEdit}
          onDuplicate={(uid) => withDraftDismissed(() => duplicate(uid))}
          onDelete={(uid) => withDraftDismissed(() => remove(uid))}
          onMove={(uid, direction) => withDraftDismissed(() => move(uid, direction))}
          onReorder={(fromUid, toUid) => withDraftDismissed(() => reorder(fromUid, toUid))}
          onSetDisabled={(uid, value) => withDraftDismissed(() => setDisabled(uid, value))}
        />
      ) : null}
    </CardEditorScreen>
  );
}
