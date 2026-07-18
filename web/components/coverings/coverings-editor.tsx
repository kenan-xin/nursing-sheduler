"use client";

// Shift Type Coverings editor (T13, spec 11), rebuilt onto the shared ScreenCards
// chrome (audit M1/m1/m2). The orchestrator composes the prototype header (eyebrow,
// display title, full subtitle, inline top-right Add), the persistent "exact
// constraints" info strip, the add/edit form, the list heading with a live rule
// count, the centred empty state (shown only with no rules AND no open draft), and
// the saved-card list. The store slice remains the single source of truth; the form
// is a transient draft that only touches state through the `useCoverings`
// operations (one tracked mutation each).

import { useLayoutEffect, useRef, useState } from "react";
import {
  CardEditorScreen,
  CardEditorHeader,
  CardEditorInfoStrip,
  CardEditorInstructions,
  CardListHeading,
  CardEditorEmptyState,
  useCardEditorDraftGuard,
  useCardEditorStaleGuard,
} from "@/components/card-editor/card-editor-shell";
import type { CoveringCard } from "@/lib/scenario";
import { CoveringForm } from "./covering-form";
import { CoveringCardList } from "./covering-card-list";
import { useCoverings } from "./use-coverings";
import {
  coveringToForm,
  emptyCoveringForm,
  isEditableCoveringCard,
  type CoveringFormState,
} from "./coverings-model";

type Draft =
  | { mode: "add"; uid: null; form: CoveringFormState }
  | { mode: "edit"; uid: string; form: CoveringFormState };

const EYEBROW = "CONSTRAINT · SHIFT TYPE COVERINGS";
const TITLE = "Shift Type Coverings";
const SUBTITLE =
  "A separate hard constraint: whenever a preceptee works a chosen shift type, at least one of their preceptors must be on the same shift. Distinct from affinities, which only encourage people to work together.";
const ADD_LABEL = "Add Shift Type Covering";
const LIST_TITLE = "Current Shift Type Coverings";
const EMPTY_MESSAGE = 'No covering rules yet. Click "Add Shift Type Covering" to get started.';
const INSTRUCTIONS = [
  "Define a shift type covering rule to enforce that whenever someone in Preceptees works the chosen shift, at least one person in Preceptors also works it.",
  "Pick the Dates this rule applies to. Leave empty to apply to all dates.",
  "Select Preceptors — these are the senior staff who must cover (e.g. supervising nurses).",
  "Select Preceptees — these are the people who must be covered (e.g. students, mentees).",
  "Select the Shift Types this rule applies to (e.g. Day shift).",
  "This covering is always enforced as a hard rule — the solver ignores its weight, so there is no soft/hard dial here.",
  "Use Edit / Duplicate / Delete on a saved rule to manage it. Drag cards to reorder.",
] as const;

export function CoveringsEditor() {
  const { state, coverings, add, update, remove, duplicate, move, reorder, setDisabled, getCards } =
    useCoverings();
  const [draft, setDraft] = useState<Draft | null>(null);
  useCardEditorDraftGuard("coverings", !!draft);
  const { isStale } = useCardEditorStaleGuard<CoveringCard>({
    cards: coverings,
    draftOpen: !!draft,
    readLiveCards: getCards,
    onStale: () => setDraft(null),
  });
  const topRef = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<{ el: HTMLElement | null; top: number } | null>(null);

  function scrollContainer(): HTMLElement | null {
    let el: HTMLElement | null = topRef.current?.parentElement ?? null;
    while (el) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return el;
      el = el.parentElement;
    }
    return null;
  }

  useLayoutEffect(() => {
    if (draft !== null || pendingRestore.current === null) return;
    const { el, top } = pendingRestore.current;
    pendingRestore.current = null;
    if (el) el.scrollTo({ top, behavior: "instant" });
    else window.scrollTo({ top, behavior: "instant" });
  }, [draft]);

  function openAdd() {
    // The Add toggle also closes an open draft (spec 11 FR-CV-03).
    setDraft(draft ? null : { mode: "add", uid: null, form: emptyCoveringForm() });
  }

  function openEdit(uid: string) {
    const card = coverings.find((c) => c.uid === uid);
    if (!card || !isEditableCoveringCard(card)) return;
    const scroller = scrollContainer();
    if (pendingRestore.current === null) {
      pendingRestore.current = {
        el: scroller,
        top: scroller ? scroller.scrollTop : window.scrollY,
      };
    }
    if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
    else window.scrollTo({ top: 0, behavior: "instant" });
    setDraft({ mode: "edit", uid, form: coveringToForm(card) });
  }

  function save(form: CoveringFormState) {
    if (isStale()) {
      setDraft(null);
      return;
    }
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
      <div ref={topRef} aria-hidden className="sr-only" />
      <CardEditorHeader
        eyebrow={EYEBROW}
        title={TITLE}
        subtitle={SUBTITLE}
        addLabel={ADD_LABEL}
        formOpen={!!draft}
        onAdd={openAdd}
        instructions={<CardEditorInstructions items={INSTRUCTIONS} />}
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
        <CardEditorEmptyState title={EMPTY_MESSAGE} addLabel={ADD_LABEL} onAdd={openAdd} />
      ) : coverings.length > 0 ? (
        <CoveringCardList
          coverings={coverings}
          onEdit={openEdit}
          onDuplicate={(uid) => withDraftDismissed(() => duplicate(uid))}
          onDelete={(uid) => withDraftDismissed(() => remove(uid))}
          onMove={(uid, direction) => withDraftDismissed(() => move(uid, direction))}
          onReorder={(fromUid, toUid, position) =>
            withDraftDismissed(() => reorder(fromUid, toUid, position))
          }
          onSetDisabled={(uid, value) => withDraftDismissed(() => setDisabled(uid, value))}
        />
      ) : null}
    </CardEditorScreen>
  );
}
